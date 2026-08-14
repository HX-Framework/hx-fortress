// Fortress ingest/read gateway — a small HTTP server that mirrors the cloud
// hx-gateway upload/read surface so hx-client talks to it with only a base-URL
// swap. Every request carries a cloud-signed Ed25519 capability token, verified
// offline against the org public key the hub pushed over the tunnel; on success
// the matching handler presigns/composes against the live session_vault store.
//
// It also serves the hx_* MCP server at POST /mcp (A5) — key-authed with the
// same capability machinery, reading the fortress's own Postgres + local blob.
import {
  handleAppendUrl,
  handleCommit,
  handleAgentAppendUrl,
  handleAgentCommit,
  handleCanonicalDownload,
  handleArtifactRead,
  handleListSessionMetadata,
  type CommitOutput,
} from "./handlers";
import {
  GRANT_REQUIRED_ERROR,
  isGrantEnforcing,
  isV2Claims,
  verifyCapabilityToken,
  verifyGrant,
  type CapabilityClaims,
  type GrantClaims,
} from "./capability-token";
import { isSessionDeleted } from "../ingest/delete";
import { ingestAgentCommit, ingestCommit, maxIso, type IngestAttribution } from "../ingest/ingest";
import { judgeAppend } from "../ingest/dedupe-guard";
import { signalReconcile } from "../ingest/reconcile-signal";
import { sanitizeDbError } from "../host/postgres/sanitize";
import { recordChunkIntent } from "../ingest/intents";
import { retryOnceOnTransientDbError } from "../host/postgres/pg-errors";
import type { HxDb } from "../host/postgres/db";
import type { HxIngestChannel } from "../host/postgres/schema/sessions";
import { isIngestPaused, type IngestPausedError, type IngestQuiesce } from "../console/pause-gate";
import type { ParkedArtifact } from "../console/artifact-replay";
import type { HxIngestNotification } from "../host/types";
import type { Embedder } from "../modules/embed-worker/openai";
import type { SessionStore } from "../modules/session-vault/store/types";
import {
  parseSessionMetadata,
  SESSION_METADATA_ARTIFACT,
} from "../modules/session-vault/store/session-metadata";
import { handleMcpRequest } from "../mcp/server";
import packageJson from "../../package.json";

/** A direct-gateway upload never passed through the cloud, so it is NOT
 *  eligible for raw-id residency disclosure. */
const GATEWAY_CHANNEL: HxIngestChannel = "gateway";

export interface GatewayLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface GatewayDeps {
  /** Resolves the live session_vault store, or null when the module isn't ready. */
  store: () => SessionStore | null;
  /** Cached org Ed25519 public key (base64url), or null before the hub pushes it. */
  signingKey: () => Promise<string | null>;
  /** This fortress's own org id (from its enrolled cloud credential), or null
   *  before enrollment. Lets verify reject a capability token whose `aud` names a
   *  DIFFERENT org — anti cross-org replay. Omitted ⇒ no aud-vs-org check. */
  ownOrgId?: () => Promise<string | null>;
  /** True once the local Postgres is accepting connections. */
  postgresReady: () => boolean;
  /** True while the live pool is rejecting queries for want of a connection.
   *  Reported on /readyz; never a readiness failure — see the handler. */
  postgresSaturated?: () => boolean;
  /** RW Drizzle handle on the bundled hx-db (the DML `hx_app_rw` role) — the
   *  ingest write path. Null before Postgres is ready. */
  db: () => HxDb | null;
  /** RO Drizzle handle on the bundled hx-db (the SELECT-only `hx_app_ro` role) —
   *  the MCP read tools. Null before Postgres is ready. */
  dbRead: () => HxDb | null;
  /** The fortress's OpenAI embedder for hx_semantic_search's in-fortress query
   *  embed. null/omitted ⇒ no key ⇒ semantic search degrades to keyword. */
  embedder?: Embedder | null;
  /** Push a realtime invalidation to the cloud after a direct-gateway ingest the
   *  cloud never relayed (MC-2415). Best-effort; optional. */
  notify?: (evt: HxIngestNotification) => void;
  /** Counts deferred post-commit work so the pre-swap quiesce barrier sees it.
   *  Counted at ENQUEUE: a commit accepted a second before a pause has queued
   *  work a barrier that only watched executing calls would miss. */
  quiesce?: IngestQuiesce;
  /** Park a deferred artifact write the pause gate refused, for replay after
   *  resume. Without it such a write would be logged and dropped. */
  parkArtifact?: (entry: ParkedArtifact) => Promise<void>;
  logger: GatewayLogger;
  port: number;
}

export interface GatewayHandle {
  stop: () => void;
  port: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A paused fortress answers with the SHIPPED offline shape, byte for byte:
 *  `{"error":"vault_offline"}` at 503. The pause detail rides a Retry-After
 *  HEADER and never the body — the hx client parses this body, and a field it
 *  has never seen is a field it may reject. */
function pausedResponse(err: IngestPausedError, now: number = Date.now()): Response {
  const seconds = Math.max(1, Math.ceil((err.pausedUntil.getTime() - now) / 1000));
  return new Response(JSON.stringify({ error: "vault_offline" }), {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": String(seconds) },
  });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

async function authed(req: Request, deps: GatewayDeps): Promise<CapabilityClaims | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const key = await deps.signingKey();
  if (!key) return null;
  try {
    // Bind the token to this fortress's own org id: for a v2 token verify requires
    // `aud === org === ownOrgId`; a legacy v1 token is accepted during the compat
    // window (anti cross-org replay + the pre-grant tolerance live in verify).
    const ownOrgId = deps.ownOrgId ? await deps.ownOrgId() : null;
    return await verifyCapabilityToken(token, key, ownOrgId);
  } catch {
    return null;
  }
}

/** The capability-grant purpose a route requires: uploads ingest, reads read.
 *  Null for a path that carries no session object (health, unknown). */
function purposeForRoute(method: string, pathname: string): "ingest" | "read" | null {
  if (method === "POST") {
    switch (pathname) {
      case "/sessions/append-url":
      case "/sessions/commit":
      case "/sessions/agent-append-url":
      case "/sessions/agent-commit":
        return "ingest";
      case "/sessions/canonical-url":
      case "/sessions/artifact":
        return "read";
    }
  }
  if (method === "GET" && pathname === "/sessions") return "read";
  return null;
}

/** Per-route grant/purpose gate (verify-if-present; REQUIRE only when enforcing).
 *  A v2 token must be a valid grant of the route's purpose — a read grant used to
 *  write (or vice-versa) fails closed (403). A legacy v1 token is admitted while
 *  FORTRESS_GRANT_ENFORCE is off. Returns an error Response to short-circuit, else
 *  null. `verifyGrant` re-checks the same bearer the token was authed with. */
async function enforceRoutePurpose(
  req: Request,
  deps: GatewayDeps,
  claims: CapabilityClaims,
  purpose: "ingest" | "read",
): Promise<Response | null> {
  if (isV2Claims(claims)) {
    const key = await deps.signingKey();
    const ownOrgId = deps.ownOrgId ? await deps.ownOrgId() : null;
    const token = bearerToken(req);
    if (!key || !ownOrgId || !token) return json({ error: "unauthorized" }, 401);
    try {
      // The HTTP `/sessions/*` reads are OWN-OBJECT (sub-bound; the boundary is
      // token principal === object owner, enforced below via claims.sub), so a
      // read grant here carries no scopeHash — requireScope:false. (Ignored for
      // ingest, which never checks scopeHash.)
      await verifyGrant(token, key, ownOrgId, { purpose, requireScope: false });
      return null;
    } catch {
      return json({ error: "grant_invalid" }, 403);
    }
  }
  if (isGrantEnforcing()) return json({ error: GRANT_REQUIRED_ERROR }, 401);
  return null;
}

/** Resolve the verified read grant for a /mcp request (or null). A v2 token is
 *  re-verified as a read grant (present-but-invalid ⇒ error); a v1 token yields
 *  no grant, admitted while FORTRESS_GRANT_ENFORCE is off (the scope binding then
 *  no-ops). Returns `{ grant }` on success or `{ res }` to short-circuit. */
async function mcpGrant(
  req: Request,
  deps: GatewayDeps,
  claims: CapabilityClaims,
): Promise<{ grant?: GrantClaims } | { res: Response }> {
  if (isV2Claims(claims)) {
    const key = await deps.signingKey();
    const ownOrgId = deps.ownOrgId ? await deps.ownOrgId() : null;
    const token = bearerToken(req);
    if (!key || !ownOrgId || !token) return { res: json({ error: "unauthorized" }, 401) };
    try {
      // The /mcp reads are SCOPE-BOUND — the grant commits to a scopeHash that
      // checkScopeGrant recomputes over the tool args — so requireScope:true.
      return { grant: await verifyGrant(token, key, ownOrgId, { purpose: "read", requireScope: true }) };
    } catch {
      return { res: json({ error: "grant_invalid" }, 403) };
    }
  }
  if (isGrantEnforcing()) return { res: json({ error: GRANT_REQUIRED_ERROR }, 401) };
  return {};
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function optionalString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function metaRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface SessionKeyInput {
  userId: string;
  family: string;
  sessionId: string;
}

// On the direct gateway the cloud already attributed the session inside the
// capability token; map those claims to the ingest attribution shape.
function attributionFromClaims(claims: CapabilityClaims): IngestAttribution {
  return {
    orgExternalId: claims.org ?? null,
    repoSlug: claims.repo ?? null,
    projectExternalId: claims.project ?? null,
    deviceId: claims.deviceId ?? null,
  };
}

// Metadata ingestion is best-effort: the bytes are already committed to the
// vault, so a Postgres hiccup must not fail the upload — it's logged and the
// chunk re-ingests idempotently on the next commit.
async function ingestCommitMetadata(
  deps: GatewayDeps,
  claims: CapabilityClaims,
  key: SessionKeyInput,
  chunkId: string,
  replace: boolean,
  chunkText: string,
  commit: CommitOutput,
  meta: Record<string, unknown> | null,
): Promise<void> {
  if (!deps.db()) {
    // Canonical is durable but the index can't be written now → row-less. Nudge
    // the guarantor (symmetric with the tunnel path's PG-down branch).
    signalReconcile();
    return;
  }
  try {
    // One transient-class retry (connection kill / advisory-lock 57014),
    // re-resolving so it lands on a post-rotation pool. This whole path runs
    // post-200 inside deferPostCommit — without the retry, a maxLifetime kill
    // here leaves a permanently unindexed chunk the guarantor cannot see (it
    // reconciles ROW-LESS sessions only).
    await retryOnceOnTransientDbError(async () => {
      const db = deps.db();
      if (!db) throw new Error("postgres_not_ready");
      await ingestCommit(db, {
        attribution: attributionFromClaims(claims),
        key,
        ingestChannel: GATEWAY_CHANNEL,
        chunkId,
        replace,
        chunkText,
        totalBytes: commit.totalBytes,
        componentCount: commit.componentCount,
        meta,
      });
    });
    deps.notify?.({ userExternalId: key.userId, orgExternalId: claims.org ?? null });
  } catch (err) {
    deps.logger.error("hx metadata ingest failed", {
      sessionId: key.sessionId,
      error: sanitizeDbError(err),
    });
    // Row-less canonical: nudge the guarantor to re-index it soon.
    signalReconcile();
  }
}

async function ingestAgentCommitMetadata(
  deps: GatewayDeps,
  claims: CapabilityClaims,
  key: SessionKeyInput,
  agentId: string,
  chunkId: string,
  replace: boolean,
  chunkText: string,
  commit: CommitOutput,
  meta: Record<string, unknown> | null,
): Promise<void> {
  if (!deps.db()) {
    // Row-less canonical (PG not ready) → nudge the guarantor, as above.
    signalReconcile();
    return;
  }
  try {
    // Same transient-class retry as the parent path (post-200, guarantor-blind).
    await retryOnceOnTransientDbError(async () => {
      const db = deps.db();
      if (!db) throw new Error("postgres_not_ready");
      await ingestAgentCommit(db, {
        attribution: attributionFromClaims(claims),
        key,
        ingestChannel: GATEWAY_CHANNEL,
        agentId,
        chunkId,
        replace,
        chunkText,
        totalBytes: commit.totalBytes,
        componentCount: commit.componentCount,
        meta,
      });
    });
    deps.notify?.({ userExternalId: key.userId, orgExternalId: claims.org ?? null });
  } catch (err) {
    deps.logger.error("hx agent metadata ingest failed", {
      sessionId: key.sessionId,
      agentId,
      error: sanitizeDbError(err),
    });
    // Row-less canonical: nudge the guarantor to re-index it soon.
    signalReconcile();
  }
}

// Post-commit work (Postgres metadata ingest + the session.json artifact
// read-modify-write) runs AFTER the commit response: the device only
// needs the compose result to advance its offset and send the next chunk, and
// both steps were already best-effort. Serialized per session key so a lane's
// chunks apply in commit order — which also fixes the artifact RMW race two
// concurrent commits of one session used to have.
const postCommitChains = new Map<string, Promise<void>>();

function deferPostCommit(
  laneKey: string,
  logger: GatewayLogger,
  fn: () => Promise<void>,
  quiesce?: IngestQuiesce,
): void {
  // Counted here, at enqueue — see GatewayDeps.quiesce.
  quiesce?.enter();
  const prev = postCommitChains.get(laneKey) ?? Promise.resolve();
  const next = prev
    .then(fn)
    .catch((err: unknown) => {
      // The chain must survive a failure. Log it here rather than assume fn did —
      // the parent closure's artifact read-modify-write half has no internal
      // try/log, so without this its errors would vanish.
      if (isIngestPaused(err)) {
        // The work has been parked for replay by the closure itself; the chain
        // RESOLVES so the barrier can reach zero. Re-enqueueing here would make
        // the chain drain non-monotonic and the barrier never converge.
        logger.info("post-commit work parked: ingest paused", {
          laneKey,
          pausedUntil: err.pausedUntil.toISOString(),
        });
        return;
      }
      logger.error("post-commit work failed", {
        laneKey,
        error: sanitizeDbError(err),
      });
    })
    .finally(() => quiesce?.leave());
  postCommitChains.set(laneKey, next);
  void next.finally(() => {
    if (postCommitChains.get(laneKey) === next) postCommitChains.delete(laneKey);
  });
}

/** Wait for every queued post-commit task — tests use this to assert on
 *  deferred metadata deterministically. */
export async function flushPostCommitWork(): Promise<void> {
  while (postCommitChains.size > 0) {
    await Promise.all([...postCommitChains.values()]);
  }
}

// M-9a · cap request bodies so a single upload can't exhaust memory. The ingest
// surface streams chunk bytes to signed URLs, not through this JSON API, so 4 MiB
// is ample for the control-plane JSON (commit metadata, MCP JSON-RPC).
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

// The direct-ingest write routes that must refuse hard-deleted sessions (410).
const INGEST_WRITE_ROUTES = new Set([
  "/sessions/append-url",
  "/sessions/commit",
  "/sessions/agent-append-url",
  "/sessions/agent-commit",
]);

export function startGatewayServer(deps: GatewayDeps): GatewayHandle {
  const server = Bun.serve({
    port: deps.port,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: async (req) => {
      const url = new URL(req.url);

      // Unauthenticated liveness probe — proves the process is up. Used by the
      // platform health check; returns 200 as soon as the gateway is listening,
      // before enrollment completes, so the deploy is marked alive immediately.
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true });
      }

      // Unauthenticated readiness probe — 200 only once the session_vault store
      // is live (enrolled, connected, credentials valid), otherwise 503. Use
      // this to gate traffic; /healthz to gate liveness.
      if (req.method === "GET" && url.pathname === "/readyz") {
        const ready = deps.store() !== null && deps.postgresReady();
        // Pool saturation is REPORTED, never used to fail readiness: this
        // fortress runs single-replica, so a 503 would pull the only instance
        // out of rotation and turn a degraded ingest path into no ingest path
        // at all. The alertable signal is the "hx-db pool saturated" error line;
        // this field is what makes the state visible to a human hitting the URL,
        // which is exactly what was missing for ~13 hours on 2026-08-05.
        const saturated = deps.postgresSaturated?.() ?? false;
        return json(
          saturated ? { ok: ready, ready, saturated: true } : { ok: ready, ready },
          ready ? 200 : 503,
        );
      }

      // MCP server (A5). Key-authed like every other route, but handled BEFORE
      // the vault-store gate below: the keyword/metadata tools read only the
      // local Postgres, so they answer even when the vault store is offline
      // (only hx_session_read_events needs the store, and degrades per-tool).
      if (url.pathname === "/mcp") {
        const mcpClaims = await authed(req, deps);
        if (!mcpClaims) return json({ error: "unauthorized" }, 401);
        // A5 · H-4 · the /mcp reads run under a read grant (purpose "read"). A v2
        // token is verified as a grant here and threaded in; the scope binding is
        // enforced per tools/call inside handleMcpRequest.
        const resolved = await mcpGrant(req, deps, mcpClaims);
        if ("res" in resolved) return resolved.res;
        try {
          return await handleMcpRequest(req, {
            // Least-privilege: the MCP tools are read-only, so they run on the
            // SELECT-only RO handle, never the ingest RW one.
            db: deps.dbRead(),
            store: deps.store(),
            embedder: deps.embedder ?? null,
            version: packageJson.version,
            grant: resolved.grant,
          });
        } catch (err) {
          deps.logger.error("mcp handler failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return json({ error: "internal_error" }, 500);
        }
      }

      const claims = await authed(req, deps);
      if (!claims) return json({ error: "unauthorized" }, 401);
      const store = deps.store();
      if (!store) return json({ error: "vault_offline" }, 503);

      // Per-route purpose (verify-if-present; REQUIRE only under FORTRESS_GRANT_ENFORCE).
      const purpose = purposeForRoute(req.method, url.pathname);
      if (purpose) {
        const denied = await enforceRoutePurpose(req, deps, claims, purpose);
        if (denied) return denied;
      }

      // C-1 · the principal is the token's `sub`, NEVER a request-body userId. A
      // token with no sub can't name an object owner — reject it on object routes.
      const userId = claims.sub ?? "";
      if (purpose && !userId) return json({ error: "principal_required" }, 403);

      try {
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          // C-1 · a body.userId that disagrees with the token principal is a
          // principal↔object mismatch (403); an absent body.userId is fine.
          // (This subsumes main's #51 body.userId guard, keyed on claims.sub.)
          if (typeof body.userId === "string" && body.userId !== userId) {
            return json({ error: "principal_object_mismatch" }, 403);
          }
          // Hard-deleted sessions: refuse every direct-ingest write with the
          // same 410 body the cloud gateway uses, so the hx client has one
          // tombstone code path. Cross-family by identity (a stale-family
          // child/sidecar upload must not slip past). A fortress without ready
          // Postgres cannot consult tombstones — documented limitation of the
          // PG-less bootstrap state.
          if (INGEST_WRITE_ROUTES.has(url.pathname)) {
            const guardDb = deps.dbRead();
            const sid = str(body.sessionId);
            if (guardDb && sid && (await isSessionDeleted(guardDb, userId, sid))) {
              return json({ error: "session_deleted" }, 410);
            }
          }
          switch (url.pathname) {
            case "/sessions/append-url":
              return json(
                await handleAppendUrl(store, {
                  userId,
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                  chunkId: str(body.chunkId),
                }),
              );
            case "/sessions/commit":
              {
                const key = {
                  userId,
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                };
                const chunkId = str(body.chunkId);
                const replace = body.replace === true;
                // Read the staged chunk before composing — compose may clear staging.
                const chunkText = await store.readChunkText(key, chunkId).catch(() => "");
                // Dedupe guard (§7c): a re-send whose every record is already
                // indexed is acked with the canonical's current size — nothing
                // composed, no intent recorded, nothing deferred, nothing to
                // lose. Any uncertainty falls through to the normal path.
                // Deliberate tradeoff: the deferred metadata-artifact refresh
                // is skipped too, so meta riding on a skipped re-send waits
                // for the next REAL commit — the artifact is a legacy fallback
                // (PG owns list titles) and staleness there beats composing
                // duplicate bytes to keep it fresh.
                {
                  const guardDb = deps.db();
                  if (guardDb && !replace) {
                    const verdict = await judgeAppend(
                      guardDb,
                      { userExternalId: userId, family: key.family, sessionId: key.sessionId, agentExternalId: null },
                      chunkText,
                    );
                    if (verdict.verdict === "skip_duplicate") {
                      const size = await store.statCanonical(key).catch(() => null);
                      if (size !== null) {
                        deps.logger.info("dedupe guard: re-sent chunk skipped at commit", {
                          sessionId: key.sessionId, chunkId, records: verdict.records,
                        });
                        return json({ ok: true, totalBytes: size, componentCount: 1 });
                      }
                    }
                  }
                }
                const commit = await handleCommit(store, { ...key, chunkId, replace });
                // The canonical is now durable and we are about to ack. Record the
                // intent BEFORE returning: everything after this point is deferred
                // and can be lost without trace (PG down, a throw, or this process
                // restarting), and the client will have advanced its offset.
                //
                // Never fatal — the bytes are already safe, so failing the upload
                // over a bookkeeping row would be strictly worse than the gap it
                // records.
                const intentDb = deps.db();
                if (intentDb) {
                  await recordChunkIntent(intentDb, {
                    userExternalId: userId,
                    family: key.family,
                    sessionId: key.sessionId,
                    chunkId,
                    totalBytes: commit.totalBytes,
                  }).catch((err: unknown) => {
                    deps.logger.error("chunk intent not recorded", {
                      sessionId: key.sessionId,
                      error: sanitizeDbError(err),
                    });
                  });
                }
                const meta = metaRecord(body.meta);
                deferPostCommit(`${userId}:${key.family}:${key.sessionId}`, deps.logger, async () => {
                  await ingestCommitMetadata(deps, claims, key, chunkId, replace, chunkText, commit, meta);
                  const existing = parseSessionMetadata(
                    JSON.parse((await store.readArtifactText(key, SESSION_METADATA_ARTIFACT).catch(() => null)) ?? "null"),
                  );
                  const now = new Date().toISOString();
                  const artifactText = JSON.stringify({
                    family: key.family,
                    sessionId: key.sessionId,
                    title: optionalString(meta?.title) ?? existing?.title ?? null,
                    titleSource:
                      meta?.titleSource === "user" ||
                      meta?.titleSource === "ai" ||
                      meta?.titleSource === "fallback"
                        ? meta.titleSource
                        : (existing?.titleSource ?? null),
                    bytesUploaded: commit.totalBytes,
                    eventCount: num(meta?.eventCount, existing?.eventCount ?? 0),
                    userTextCount: num(meta?.userTextCount, existing?.userTextCount ?? 0),
                    assistantCount: num(meta?.assistantCount, existing?.assistantCount ?? 0),
                    // Same monotonic-on-append / authoritative-on-replace
                    // rule as the Postgres row (ingestCommit) — an out-of-order /
                    // backfill chunk must not regress the artifact either.
                    lastActivityAt: replace
                      ? (optionalString(meta?.lastActivityAt) ?? existing?.lastActivityAt ?? now)
                      : (maxIso(existing?.lastActivityAt, optionalString(meta?.lastActivityAt)) ?? now),
                    firstSeenAt: existing?.firstSeenAt ?? now,
                    updatedAt: now,
                    cwd: optionalString(meta?.cwd) ?? existing?.cwd ?? null,
                    gitBranch: optionalString(meta?.gitBranch) ?? existing?.gitBranch ?? null,
                    sourcePath: optionalString(meta?.sourcePath) ?? existing?.sourcePath ?? null,
                    repoSlug: optionalString(meta?.repoSlug) ?? existing?.repoSlug ?? null,
                    deviceName: existing?.deviceName ?? null,
                  });
                  try {
                    await store.writeArtifact(key, SESSION_METADATA_ARTIFACT, artifactText);
                  } catch (err) {
                    // The commit is already acknowledged and the bytes are
                    // durable; only this sidecar is left. Park it so resume
                    // replays it — dropping it would silently lose the metadata
                    // the commit promised.
                    if (isIngestPaused(err) && deps.parkArtifact) {
                      await deps.parkArtifact({
                        key,
                        name: SESSION_METADATA_ARTIFACT,
                        text: artifactText,
                        parkedAt: new Date().toISOString(),
                        // Carried so the replay can apply the same rule this
                        // composition did: a replace is authoritative and its
                        // totals may legitimately be smaller.
                        replace,
                      });
                    }
                    throw err;
                  }
                  }, deps.quiesce);
                return json(commit);
              }
            case "/sessions/agent-append-url":
              return json(
                await handleAgentAppendUrl(store, {
                  userId,
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                  agentId: str(body.agentId),
                  chunkId: str(body.chunkId),
                }),
              );
            case "/sessions/agent-commit":
              {
                const key = {
                  userId,
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                };
                const agentId = str(body.agentId);
                const chunkId = str(body.chunkId);
                const replace = body.replace === true;
                // Child lanes are stored under the composite sessionId:a:agentId key.
                const storeKey = { ...key, sessionId: `${key.sessionId}:a:${agentId}` };
                const chunkText = await store.readChunkText(storeKey, chunkId).catch(() => "");
                // Same dedupe guard as the parent path, judged against the lane.
                {
                  const guardDb = deps.db();
                  if (guardDb && !replace) {
                    const verdict = await judgeAppend(
                      guardDb,
                      { userExternalId: userId, family: key.family, sessionId: key.sessionId, agentExternalId: agentId },
                      chunkText,
                    );
                    if (verdict.verdict === "skip_duplicate") {
                      const size = await store.statCanonical(storeKey).catch(() => null);
                      if (size !== null) {
                        deps.logger.info("dedupe guard: re-sent lane chunk skipped at commit", {
                          sessionId: key.sessionId, agentId, chunkId, records: verdict.records,
                        });
                        return json({ ok: true, totalBytes: size, componentCount: 1 });
                      }
                    }
                  }
                }
                const commit = await handleAgentCommit(store, { ...key, agentId, chunkId, replace });
                // Same contract as the parent path: the lane's canonical is durable
                // and the index write is about to be deferred. A lane is a separate
                // canonical with its own turns, so it needs its own intent.
                const laneIntentDb = deps.db();
                if (laneIntentDb) {
                  await recordChunkIntent(laneIntentDb, {
                    userExternalId: userId,
                    family: key.family,
                    sessionId: key.sessionId,
                    agentExternalId: agentId,
                    chunkId,
                    totalBytes: commit.totalBytes,
                  }).catch((err: unknown) => {
                    deps.logger.error("lane chunk intent not recorded", {
                      sessionId: key.sessionId,
                      agentId,
                      error: sanitizeDbError(err),
                    });
                  });
                }
                const agentMeta = metaRecord(body.meta);
                deferPostCommit(
                  `${userId}:${key.family}:${key.sessionId}:a:${agentId}`,
                  deps.logger,
                  () =>
                    ingestAgentCommitMetadata(
                      deps,
                      claims,
                      key,
                      agentId,
                      chunkId,
                      replace,
                      chunkText,
                      commit,
                      agentMeta,
                    ),
                  deps.quiesce,
                );
                return json(commit);
              }
            case "/sessions/canonical-url":
              return json(
                await handleCanonicalDownload(store, {
                  userId,
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                }),
              );
            case "/sessions/artifact":
              return json(
                await handleArtifactRead(store, {
                  userId,
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                  name: str(body.name),
                }),
              );
          }
        }
        if (req.method === "GET" && url.pathname === "/sessions") {
          return json(await handleListSessionMetadata(store, { userId }));
        }
      } catch (err) {
        // A paused fortress is not a failed one: no error-level line, and the
        // shipped offline shape rather than internal_error, so an hx client
        // that predates the pause retries instead of surfacing a fault.
        if (isIngestPaused(err)) return pausedResponse(err);
        deps.logger.error("gateway handler failed", {
          path: url.pathname,
          error: sanitizeDbError(err),
        });
        return json({ error: "internal_error" }, 500);
      }

      return json({ error: "not_found" }, 404);
    },
  });
  const boundPort = server.port ?? deps.port;
  deps.logger.info("gateway listening", { port: boundPort });
  return { stop: () => server.stop(true), port: boundPort };
}
