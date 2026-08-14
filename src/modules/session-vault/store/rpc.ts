// Vault RPC protocol — the wire contract between the workbench-api (client side,
// via RemoteVaultStore) and a self-hosted vault (server side). Transport-
// agnostic: this module only defines request/result shapes and a dispatcher
// that runs one request against a local SessionStore. The reverse tunnel (P4)
// carries these messages; nothing here knows about sockets.

import { createPurgeDb, type HxDb } from "../../../host/postgres/db.js";
import {
  dbSqlState,
  isKillClassDbError,
  isStatementTimeoutDbError,
  retryOnceOnTransientDbError,
  SessionLockTimeoutError,
} from "../../../host/postgres/pg-errors.js";
import { sanitizeDbError } from "../../../host/postgres/sanitize.js";
import { withDeadline } from "../../../host/with-deadline.js";
import {
  baseSessionId,
  markSessionDeleted,
  purgeSessionPg,
  type PgPurgeResult,
} from "../../../ingest/delete.js";
import { recordChunkIntent } from "../../../ingest/intents.js";
import { dedupeGuardEnabled, judgeAppend } from "../../../ingest/dedupe-guard.js";
import { AGENT_LANE } from "../../../ingest/health.js";
import { signalReconcile } from "../../../ingest/reconcile-signal.js";
import {
  ingestAgentCommit,
  ingestCommit,
  type IngestAttribution,
} from "../../../ingest/ingest.js";
import type { HxIngestChannel } from "../../../host/postgres/schema/sessions.js";
import { listSessionsForUser } from "../../../query/list-sessions.js";
import { maxTunnelResultBytes } from "./limits.js";
import { stripListTitle } from "./session-metadata.js";
import { storeHeavyTimeoutMs } from "../store.js";
import { isPauseGated } from "../../../console/pause-gate.js";
import type {
  ComposeResult,
  SessionKey,
  SessionMetadata,
  SessionStore,
  SignedDownload,
  SignedUpload,
} from "./types.js";

/** Every ingest through this dispatcher arrived over the reverse tunnel — the
 *  cloud relayed it — which is the only provenance residency disclosure treats
 *  as eligible to name raw session ids. */
const TUNNEL_CHANNEL: HxIngestChannel = "tunnel";

/** Shared payload for the two metadata-ingest RPCs the cloud sends after a
 *  commit so the fortress mirrors the session into its own hx schema. The
 *  cloud passes the chunk text it already read plus the attribution it already
 *  resolved; the fortress re-parses and writes rows locally. */
export interface IngestCommitRpc {
  key: SessionKey;
  chunkId: string;
  replace?: boolean;
  chunkText: string;
  totalBytes: number;
  componentCount: number;
  meta: Record<string, unknown> | null;
  attribution: IngestAttribution;
  /** When set, `chunkText` is the WHOLE transcript (a from-scratch replace), so
   *  persist it verbatim as the canonical log in addition to indexing it. Callers
   *  that upload the canonical separately (staged chunks + compose) leave this
   *  unset. Older binaries ignore the extra field (no canonical written). */
  writeCanonical?: boolean;
}

/** One prepared "my sessions" row, read from the fortress hx Postgres (MC-2415).
 *  Names (org/project/repo/model/device) are resolved fortress-side from the
 *  mirrored dimension tables, so the cloud needs no further joins to render the
 *  list. Mirrors the let-forge `FortressSessionRow` contract — keep in sync. */
export interface FortressSessionRow {
  family: string;
  sessionId: string;
  title: string | null;
  titleSource: "user" | "ai" | "fallback" | null;
  cwd: string | null;
  gitBranch: string | null;
  sourcePath: string | null;
  repoSlug: string | null;
  orgName: string | null;
  projectName: string | null;
  model: string | null;
  eventCount: number;
  userTextCount: number;
  assistantCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estCostUsd: number | null;
  bytesUploaded: number;
  deviceName: string | null;
  firstSeenAt: string;
  lastActivityAt: string | null;
  updatedAt: string;
}

export type VaultRpcRequest =
  | { method: "signStagingUpload"; key: SessionKey; chunkId: string }
  | { method: "readChunkText"; key: SessionKey; chunkId: string }
  // `replace` (divergence repair) is honored by vaults built after it was
  // added; older vault binaries simply ignore the extra field and append.
  | { method: "appendChunkToCanonical"; key: SessionKey; chunkId: string; replace?: boolean }
  | { method: "signCanonicalDownload"; key: SessionKey }
  // Locked-bucket path: the vault reads the canonical itself (inside the
  // customer network) and streams the bytes back base64-encoded, instead of
  // handing out a signed URL the let.ai side would fetch directly.
  | { method: "readCanonical"; key: SessionKey }
  | { method: "statCanonical"; key: SessionKey }
  | { method: "writeArtifact"; key: SessionKey; name: string; text: string }
  | { method: "readArtifactText"; key: SessionKey; name: string }
  | { method: "listSessionMetadata"; userId: string }
  // Prepared "my sessions" read against the fortress hx Postgres (MC-2415).
  // Postgres-backed vaults only; older binaries reject the unknown method and
  // the cloud falls back to listSessionMetadata.
  | { method: "listSessions"; userId: string; limit?: number }
  // Metadata-ingest RPCs (MC-2406) — written to the fortress hx schema. Honored
  // by vaults built with the embedded/external Postgres; older binaries reject
  // the unknown method, which the cloud treats as best-effort.
  | ({ method: "ingestCommit" } & IngestCommitRpc)
  | ({ method: "ingestAgentCommit"; agentId: string } & IngestCommitRpc)
  // Permanent hard delete of one session (cloud-initiated). Tombstones the
  // identity first, then purges Postgres + every bucket object/version in
  // bounded batches — idempotent, the cloud re-calls until `complete`. Older
  // binaries reject the unknown method; the cloud gates on the fortress
  // version and parks the purge as "update required".
  | { method: "deleteSession"; key: SessionKey; batchLimit?: number }
  | { method: "selfTest" };

export type VaultRpcResult =
  | { method: "signStagingUpload"; value: SignedUpload }
  | { method: "readChunkText"; value: string }
  | { method: "appendChunkToCanonical"; value: ComposeResult }
  | { method: "signCanonicalDownload"; value: SignedDownload }
  | { method: "readCanonical"; value: { base64: string } }
  | { method: "statCanonical"; value: number | null }
  | { method: "writeArtifact"; value: { ok: true } }
  | { method: "readArtifactText"; value: string | null }
  | { method: "listSessionMetadata"; value: SessionMetadata[] }
  | { method: "listSessions"; value: FortressSessionRow[] }
  | { method: "ingestCommit"; value: { ok: true } }
  | { method: "ingestAgentCommit"; value: { ok: true } }
  | { method: "deleteSession"; value: { complete: boolean; deleted: number } }
  | { method: "selfTest"; value: { ok: true } };

export interface VaultRpcError {
  error: string;
}

/** The verified authorization a tunnel grant carries into a vault RPC (H-4): the
 *  principal (`sub`) the cloud minted the grant for, plus the read grant's scope
 *  commitment. Present only when the connection verified a grant; absent in the
 *  compat window (see connection.ts). */
export interface VaultAuthz {
  sub: string;
  scopeHash?: string;
}

/** The vault RPCs that MUTATE stored objects — each is bound to its `key.userId`
 *  owner, so a grant may only drive them for its own principal (H-4). */
const VAULT_WRITE_METHODS: ReadonlySet<string> = new Set([
  "signStagingUpload",
  "appendChunkToCanonical",
  "writeArtifact",
  "ingestCommit",
  "ingestAgentCommit",
  "deleteSession",
]);

/** True for a mutating vault RPC method (drives the ingest vs read grant purpose). */
export function isVaultWriteMethod(method: string): boolean {
  return VAULT_WRITE_METHODS.has(method);
}

/** The capability-grant purpose a vault RPC method requires: writes need an
 *  `ingest` grant, everything else a `read` grant. */
export function vaultRpcPurpose(method: string): "ingest" | "read" {
  return isVaultWriteMethod(method) ? "ingest" : "read";
}

/** The user id the request's object belongs to, or null for object-free methods
 *  (`selfTest`). Writes and object reads both carry a `key`; the list reads carry
 *  a bare `userId`. */
function objectUserId(req: VaultRpcRequest): string | null {
  if ("key" in req && req.key) return req.key.userId;
  if ("userId" in req) return req.userId;
  return null;
}

/**
 * Execute one RPC request against a local SessionStore. The vault calls this for
 * each request the tunnel forwards. Throws on unknown methods or store errors;
 * the caller maps the throw to a VaultRpcError on the wire.
 *
 * H-4 · when `authz` is present (the connection verified a grant), the object the
 * RPC touches must belong to the grant's principal — `key.userId === authz.sub`
 * (or `userId === authz.sub` for the list reads). A mismatch fails closed with
 * `principal_object_mismatch`. `selfTest` carries no object and is never gated.
 *
 * `db` RESOLVES the RW (DML) handle per call — a resolver, not a handle, so the
 * transient-class retries land on a post-rotation pool after guarded-db swaps
 * the generation mid-RPC. `dbRead` resolves the SELECT-only RO handle for the
 * `listSessions` metadata read (least-privilege), falling back to `db` when
 * omitted. `purgeDsn` resolves the RW DSN for deleteSession's dedicated purge
 * client (null/omitted ⇒ shared handle for tests / typed park when wired).
 */
/** Minimal logger seam for the durability-first ingest branch, which acks the
 *  RPC even when indexing can't run (canonical already persisted) — the failure
 *  must still be observable rather than silently swallowed. */
export interface VaultRpcLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** PG-phase deadline (ms), under the cloud tunnel's 30 s RPC abandon: a wedged
 *  pool must yield a TYPED error the cloud can log and classify instead of a
 *  silent hang the tunnel gives up on. Read per call (not at module init) so
 *  the hidden override works for tests/emergencies regardless of import order. */
function pgRpcDeadlineMs(): number {
  const n = Number(process.env.FORTRESS_DB_RPC_DEADLINE_MS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 25_000;
}

/** Race ONLY the PG phase of a vault RPC. NEVER cancels: a late transaction is
 *  exactly-once safe (in-txn dedupe key + per-session advisory lock), so the
 *  loser detaches with a LOG-then-swallow observer — a 57014 kill behind a
 *  lost race must stay observable, and Bun exits the process on an unhandled
 *  rejection. The race wraps the RETRY wrapper, not each attempt. */
async function racePgPhase<T>(
  run: () => Promise<T>,
  tag: string,
  logger?: VaultRpcLogger,
): Promise<T> {
  const phase = run();
  try {
    return await withDeadline(phase, pgRpcDeadlineMs(), tag);
  } catch (err) {
    if (err instanceof Error && err.message === tag) {
      phase.then(
        () => logger?.warn("vault RPC pg phase settled after deadline", { tag }),
        (late: unknown) =>
          logger?.warn("vault RPC pg phase failed after deadline", {
            tag,
            error: sanitizeDbError(late),
            // The SQLSTATE separately: a bare PostgresError's message doesn't
            // carry it, and "57014 killed a statement behind a lost race" is
            // exactly the giant-statement residual worth grepping for.
            sqlState: dbSqlState(late),
          }),
      );
    }
    throw err;
  }
}

export async function handleVaultRpc(
  store: SessionStore,
  req: VaultRpcRequest,
  db: (() => HxDb | null) | null = null,
  authz?: VaultAuthz,
  dbRead: (() => HxDb | null) | null = null,
  logger?: VaultRpcLogger,
  purgeDsn: (() => string | null) | null = null,
): Promise<VaultRpcResult> {
  const resolveDb = db ?? ((): HxDb | null => null);

  /** Record the composed-but-maybe-unindexed intent. Best effort, never throws.
   *
   *  MUST cover EVERY commit branch. It used to live only inside the
   *  `writeCanonical` mirror branch — that is where the one observed hole was
   *  (session 95b9f361) — so on production it recorded nothing at all for ordinary
   *  chunk commits: 178 ingestCommit RPCs served, zero "not recorded" warnings,
   *  zero rows. The hole is not mirror-specific. `racePgPhase` ABANDONS the loser
   *  rather than cancelling it, and the HTTP path's deferPostCommit has no
   *  durability, on every branch alike.
   *
   *  Never fatal: the ack already promises the bytes are durable and that promise
   *  still holds. A failure here degrades to the pre-0017 behaviour — the drop stays
   *  invisible — which beats failing an upload over a bookkeeping row. */
  const noteChunkIntent = async (
    key: { userId: string; family: string; sessionId: string },
    chunkId: string,
    totalBytes: number,
    agentExternalId?: string | null,
  ): Promise<void> => {
    const intentDb = resolveDb();
    if (!intentDb) return;
    await recordChunkIntent(intentDb, {
      userExternalId: key.userId,
      family: key.family,
      sessionId: key.sessionId,
      agentExternalId: agentExternalId ?? null,
      chunkId,
      totalBytes,
    }).catch((err: unknown) => {
      logger?.warn("chunk intent not recorded", {
        sessionId: key.sessionId,
        error: sanitizeDbError(err),
      });
    });
  };
  if (authz && req.method !== "selfTest") {
    const owner = objectUserId(req);
    if (owner !== null && owner !== authz.sub) {
      throw new Error("principal_object_mismatch");
    }
  }
  switch (req.method) {
    case "signStagingUpload":
      return { method: req.method, value: await store.signStagingUpload(req.key, req.chunkId) };
    case "readChunkText": {
      const value = await store.readChunkText(req.key, req.chunkId);
      // Bound the tunnel result so its base64 can't exceed the peer's frame cap
      // (which would drop the socket). Fail fast with a typed reason instead.
      if (Buffer.byteLength(value) > maxTunnelResultBytes()) throw new Error("chunk_too_large");
      return { method: req.method, value };
    }
    case "appendChunkToCanonical": {
      // Dedupe guard (§7c): a re-send whose EVERY record is already indexed is
      // answered with the canonical's CURRENT size instead of composed again —
      // provably loss-free, and the ingest RPC gives the same verdict, so the
      // pair stays a no-op end to end. Every uncertain branch (no db, read
      // failure, unjudgeable chunk, stat failure) falls through to a real
      // compose: fail open, never refuse. No intent is recorded on a skip —
      // nothing was promised.
      const guardDb = resolveDb();
      if (guardDb && req.replace !== true && dedupeGuardEnabled()) {
        const staged = await store.readChunkText(req.key, req.chunkId).catch(() => null);
        if (staged !== null) {
          const laneIdx = req.key.sessionId.indexOf(AGENT_LANE);
          const verdict = await judgeAppend(
            guardDb,
            {
              userExternalId: req.key.userId,
              family: req.key.family,
              sessionId: laneIdx >= 0 ? req.key.sessionId.slice(0, laneIdx) : req.key.sessionId,
              agentExternalId:
                laneIdx >= 0 ? req.key.sessionId.slice(laneIdx + AGENT_LANE.length) : null,
            },
            staged,
          );
          if (verdict.verdict === "skip_duplicate") {
            const size = await store.statCanonical(req.key).catch(() => null);
            if (size !== null) {
              logger?.warn("dedupe guard: re-sent chunk skipped at compose", {
                sessionId: req.key.sessionId,
                chunkId: req.chunkId,
                records: verdict.records,
              });
              // componentCount is consumed by nothing on the skip path (the
              // paired ingest skips too); 1 is a placeholder, not a claim.
              return { method: req.method, value: { totalBytes: size, componentCount: 1 } };
            }
          } else if (verdict.overlap > 0) {
            logger?.warn("dedupe guard: append overlaps already-indexed records — passed", {
              sessionId: req.key.sessionId,
              chunkId: req.chunkId,
              overlap: verdict.overlap,
            });
          }
        }
      }
      return {
        method: req.method,
        value: await store.appendChunkToCanonical(req.key, req.chunkId, { replace: req.replace }),
      };
    }
    case "signCanonicalDownload":
      return { method: req.method, value: await store.signCanonicalDownload(req.key) };
    case "statCanonical":
      return { method: req.method, value: await store.statCanonical(req.key) };
    case "readCanonical": {
      // M-9c · reject an oversized whole-object read before fetching it into memory.
      // The tunnel-result cap (< frame cap) also prevents the base64 payload from
      // exceeding the peer's maxPayload and dropping the socket.
      const size = await store.statCanonical(req.key);
      if (size !== null && size > maxTunnelResultBytes()) throw new Error("canonical_too_large");
      const { url } = await store.signCanonicalDownload(req.key);
      // Low · a thrown fetch error can embed the signed URL — swallow the original
      // and surface a URL-free reason so the signed URL never reaches logs/replies.
      let buf: Buffer;
      let status = 0;
      try {
        // redirect:"error" — a validated signed URL must not 3xx-redirect into a
        // private/metadata address (SSRF): a redirect makes fetch throw, which we
        // map to the URL-free network reason below (fail-closed).
        // AbortSignal.timeout — this raw fetch bypasses the store and therefore
        // GuardedStore's deadlines; the signal also bounds the BODY read, so a
        // stall mid-transfer surfaces the same URL-free typed reason instead of
        // a raw TimeoutError. Budget mirrors the store's heavy-op deadline.
        const res = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(storeHeavyTimeoutMs()),
        });
        status = res.status;
        if (!res.ok) throw new Error("http_status");
        buf = Buffer.from(await res.arrayBuffer());
      } catch {
        throw new Error(
          status >= 400 ? `canonical_fetch_failed:${status}` : "canonical_fetch_failed:network",
        );
      }
      // Belt-and-suspenders: enforce the tunnel cap on the actual bytes too (stat
      // can be null/racey), so the base64 result never overflows the frame.
      if (buf.byteLength > maxTunnelResultBytes()) throw new Error("canonical_too_large");
      return { method: req.method, value: { base64: buf.toString("base64") } };
    }
    case "writeArtifact":
      await store.writeArtifact(req.key, req.name, req.text);
      return { method: req.method, value: { ok: true } };
    case "readArtifactText":
      return { method: req.method, value: await store.readArtifactText(req.key, req.name) };
    case "listSessionMetadata":
      // MC-2606 — PG owns the list title; this legacy fallback serves content-only.
      return { method: req.method, value: stripListTitle(await store.listSessionMetadata(req.userId)) };
    case "listSessions": {
      // Least-privilege: the "my sessions" metadata read is SELECT-only, so it
      // runs on the RO handle (falling back to the RW handle when a single handle
      // was passed — external Postgres / tests). Resolved ONCE per RPC.
      const readDb = (dbRead ?? resolveDb)();
      if (!readDb) throw new Error("postgres_not_ready");
      // The typed tag deliberately does NOT match the cloud's old-binary
      // fallback regex (/unknown_vault_method|listSessions/, camelCase) — it
      // must PROPAGATE so the org shows offline, never a silently title-
      // stripped blob-fallback list (the MC-2606 symptom).
      return {
        method: req.method,
        value: await racePgPhase(
          () => listSessionsForUser(readDb, { userId: req.userId, limit: req.limit }),
          "db_unavailable:list_sessions",
          logger,
        ),
      };
    }
    case "ingestCommit": {
      // Durability FIRST: for whole-transcript producers (mirrors,
      // writeCanonical) this blob IS the transcript — the cloud deletes its own
      // copy on our ack for residency moves, so the ack must mean "durably
      // persisted". It used to be written AFTER the full indexing pass, so an
      // unavailable Postgres or a mid-index crash lost the transcript the ack
      // was about to vouch for.
      if (req.writeCanonical) {
        await store.writeCanonicalText(req.key, req.chunkText);
        if (!resolveDb()) {
          // Canonical persisted; the index can't be written right now. Mirror
          // producers re-send the whole transcript (replace) on their next
          // update, which rebuilds the index — ack rather than fail, but make
          // the skipped index observable.
          logger?.warn("ingestCommit indexed skipped: postgres unavailable", {
            sessionId: req.key.sessionId,
          });
          // Row-less canonical: nudge the guarantor to re-index once PG returns.
          signalReconcile();
          return { method: req.method, value: { ok: true } };
        }
        // Record the intent before the PG phase is raced. This path is where the
        // one production instance of the hole was observed (session 95b9f361, a
        // workbench-chat mirror on 2026-08-07 18:04Z): the canonical reached
        // 5,796 bytes, one 2,806-byte chunk was indexed, and the second index
        // write never arrived. `racePgPhase` ABANDONS the loser rather than
        // cancelling it, so a lost race leaves exactly this state.
        //
        // Never fatal: the ack already promises the bytes are durable, and that
        // promise still holds.
        await noteChunkIntent(req.key, req.chunkId, req.totalBytes);
        try {
          // Race ONLY the PG phase (the canonical write above stays outside —
          // ack = "durably persisted" must stay truthful); one transient-class
          // retry runs INSIDE the race, re-resolving so it lands on a
          // post-rotation pool. A retry-time null resolver falls into the catch
          // — the ack+signalReconcile contract holds on every failure path.
          await racePgPhase(
            () =>
              retryOnceOnTransientDbError(() => {
                const h = resolveDb();
                if (!h) throw new Error("db_unavailable:ingest_commit");
                return ingestCommit(h, {
                  key: req.key,
                  ingestChannel: TUNNEL_CHANNEL,
                  chunkId: req.chunkId,
                  replace: req.replace === true,
                  chunkText: req.chunkText,
                  totalBytes: req.totalBytes,
                  componentCount: req.componentCount,
                  meta: req.meta,
                  attribution: req.attribution,
                });
              }),
            "db_unavailable:ingest_commit",
            logger,
          );
        } catch (err) {
          // Same self-healing property as above: the transcript is safe, the
          // next whole-transcript send re-indexes. Log so a persistent index
          // failure (a real schema/data bug, not a transient) is visible.
          logger?.warn("ingestCommit indexing failed after canonical persisted", {
            sessionId: req.key.sessionId,
            error: sanitizeDbError(err),
          });
          // Row-less canonical: nudge the guarantor to re-index it soon.
          signalReconcile();
        }
        return { method: req.method, value: { ok: true } };
      }
      // Chunked producers: the composed canonical already lives in the store;
      // indexing failures must surface TYPED so the (idempotent, dedupe-keyed)
      // forward can retry — a silent hang is what the cloud abandons at 30 s.
      if (!resolveDb()) throw new Error("postgres_not_ready");
      // BEFORE the PG phase: an abandoned or failed ingest must leave the intent
      // OPEN, which is the entire signal.
      await noteChunkIntent(req.key, req.chunkId, req.totalBytes);
      await racePgPhase(
        () =>
          retryOnceOnTransientDbError(() => {
            const h = resolveDb();
            if (!h) throw new Error("db_unavailable:ingest_commit");
            return ingestCommit(h, {
              key: req.key,
              ingestChannel: TUNNEL_CHANNEL,
              chunkId: req.chunkId,
              replace: req.replace === true,
              chunkText: req.chunkText,
              totalBytes: req.totalBytes,
              componentCount: req.componentCount,
              meta: req.meta,
              attribution: req.attribution,
            });
          }),
        "db_unavailable:ingest_commit",
        logger,
      );
      return { method: req.method, value: { ok: true } };
    }
    case "ingestAgentCommit": {
      if (!resolveDb()) throw new Error("postgres_not_ready");
      // A lane is a SEPARATE canonical with its own turns, so a dropped lane index
      // write is its own loss — and this branch recorded no intent whatsoever.
      await noteChunkIntent(req.key, req.chunkId, req.totalBytes, req.agentId);
      await racePgPhase(
        () =>
          retryOnceOnTransientDbError(() => {
            const h = resolveDb();
            if (!h) throw new Error("db_unavailable:agent_commit");
            return ingestAgentCommit(h, {
              key: req.key,
              ingestChannel: TUNNEL_CHANNEL,
              agentId: req.agentId,
              chunkId: req.chunkId,
              replace: req.replace === true,
              chunkText: req.chunkText,
              totalBytes: req.totalBytes,
              componentCount: req.componentCount,
              meta: req.meta,
              attribution: req.attribution,
            });
          }),
        "db_unavailable:agent_commit",
        logger,
      );
      return { method: req.method, value: { ok: true } };
    }
    case "deleteSession": {
      // The ONE enumerated pre-check outside the store gate. Everything else
      // reaches the gate through the store call itself, but this branch
      // tombstones the identity and purges Postgres FIRST — both irreversible,
      // and both would punch a hole in the snapshot a storage migration is
      // copying. So the gate has to sit ahead of the tombstone, not behind it.
      if (isPauseGated(store)) store.assertWritable();
      // Tombstone + purge both need Postgres; without it the guard could not
      // hold, so fail typed (the cloud parks the job, no attempt burned).
      const first = resolveDb();
      if (!first) throw new Error("postgres_not_ready");
      const key = { ...req.key, sessionId: baseSessionId(req.key.sessionId) };
      try {
        // Tombstone FIRST — re-ingest is blocked even if the purge below is
        // interrupted; every subsequent call is a converging retry. Shared-pool
        // phase: one transient-class retry, re-resolving post-rotation.
        await retryOnceOnTransientDbError(() => {
          const h = resolveDb();
          if (!h) throw new Error("postgres_not_ready");
          return markSessionDeleted(h, key);
        });
        // Purge on a DEDICATED short-lived param-free client (no
        // statement_timeout, no maxLifetime): an oversized purge statement must
        // finish server-side even after the cloud abandons the RPC — the next
        // parked retry finds complete:true (zombie-convergence). The shared
        // pools' bounds would turn that into a never-converging park loop.
        // Residuals (accepted): the purge occupies one server slot until it
        // finishes (same as today), and against a black-holed server a hung
        // invocation is only reclaimed by OS socket reap (~15-30 min) — with
        // the cloud's ~2 min park self-retry that is ~8-15 concurrently hung
        // invocations per pending delete job, strictly better than the
        // pre-0.17 forever-hang.
        let pg: PgPurgeResult;
        const dedicatedDsn = purgeDsn ? purgeDsn() : null;
        if (purgeDsn && !dedicatedDsn) throw new Error("postgres_not_ready");
        if (dedicatedDsn) {
          const purge = createPurgeDb(dedicatedDsn);
          try {
            pg = await purgeSessionPg(purge.db, key, Date.now() + 10_000);
          } finally {
            purge.close();
          }
        } else {
          // No purgeDsn seam wired (tests / legacy embedding) — shared handle,
          // exact prior behavior.
          pg = await purgeSessionPg(first, key, Date.now() + 10_000);
        }
        const bucket = await store.deleteSession(key, { batchLimit: req.batchLimit ?? 500 });
        return {
          method: req.method,
          value: { complete: pg.complete && bucket.complete, deleted: bucket.deleted },
        };
      } catch (err) {
        // Park mapping: transient DB failures must PARK the cloud's purge job
        // (the park refunds the attempt and self-retries ~2 min later) — the
        // raw driver text matches neither cloud regex and would burn the job
        // to dead_letter, which needs manual revival. Genuine SQL/schema
        // failures still propagate raw → dead_letter — those need operator
        // eyes. The :statement_timeout suffix substring-parks the same regex
        // while keeping the fortress-side label truthful.
        if (err instanceof SessionLockTimeoutError || isStatementTimeoutDbError(err)) {
          throw new Error("postgres_not_ready:statement_timeout", { cause: err });
        }
        if (isKillClassDbError(err)) throw new Error("postgres_not_ready", { cause: err });
        throw err;
      }
    }
    case "selfTest":
      await store.selfTest();
      return { method: req.method, value: { ok: true } };
    default: {
      const _exhaustive: never = req;
      throw new Error(`unknown_vault_method:${JSON.stringify(_exhaustive)}`);
    }
  }
}
