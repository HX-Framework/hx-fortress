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
import { parseChunk } from "../../../ingest/parse.js";
import type { HxIngestChannel } from "../../../host/postgres/schema/sessions.js";
import { listSessionsForUser } from "../../../query/list-sessions.js";
import { maxCanonicalBytes, maxTunnelResultBytes } from "./limits.js";
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
  // Bytes-free re-index (LETAIR-300). The workbench sends key + chunkId +
  // metadata ONLY — NO `chunkText` — and the fortress reads its OWN canonical
  // locally and indexes it, so a whole-transcript REPLACE never crosses the
  // tunnel as an oversized frame (the ~36-40 MB `ingestCommit` frames that were
  // dropped over the 32 MiB cap). `agentId` re-indexes the LANE's own canonical
  // (`<sessionId>:a:<agentId>`), never the parent. Older binaries reject the
  // unknown WRITE method — it fails the grant purpose as `unauthorized`, NOT
  // `unknown_vault_method` — so the cloud version-gates on
  // MIN_FORTRESS_REINDEX_VERSION and falls back to the inline `ingestCommit`.
  | {
      method: "reindexCanonical";
      key: SessionKey;
      chunkId: string;
      replace: boolean;
      componentCount: number;
      meta: Record<string, unknown> | null;
      attribution: IngestAttribution;
      agentId?: string;
    }
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
  | {
      method: "reindexCanonical";
      value: {
        // applied = a genuine index write; deduped = the chunk/records were
        // already indexed (a no-op); superseded = the canonical was missing or
        // empty and was skipped WITHOUT wiping the lane.
        outcome: "applied" | "deduped" | "superseded";
        // Object (stat) bytes now covered by the index. The workbench fences and
        // drops covered lane jobs against this ONLY on `applied`; 0 when superseded.
        coveredEnd: number;
      };
    }
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
  // Bytes-free re-index re-writes the index (a REPLACE), so it needs the same
  // `ingest` grant as the other commit methods — NOT a `read` grant.
  "reindexCanonical",
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
    case "reindexCanonical": {
      // LETAIR-300 · bytes-free re-index. The workbench asked us to REPLACE-index
      // a whole canonical it did NOT send — sending it inline is the ~36-40 MB
      // `ingestCommit` frame that was dropped over the 32 MiB tunnel cap. We read
      // our OWN copy and index it. The stat + cap-gate + read + emptiness guard
      // ALL run OUTSIDE the ingest transaction: `readCanonicalText` is an uncapped
      // bare store download, and awaiting it inside `ingestCommit`'s txn would
      // hold the checked-out connection idle-in-transaction for the whole
      // download — the exact hold class LETAIR-301 fights.
      const agentId = req.agentId != null && req.agentId !== "" ? req.agentId : null;
      // Read the RIGHT canonical: the parent's key, or the agent LANE's OWN object
      // `<sessionId>:a:<agentId>` — never the parent's. `req.key.sessionId` is the
      // PARENT id (same contract as `ingestAgentCommit`), so the read key and the
      // index write below both derive the lane from it identically.
      const readKey: SessionKey =
        agentId !== null
          ? { ...req.key, sessionId: `${req.key.sessionId}${AGENT_LANE}${agentId}` }
          : req.key;
      // Missing canonical ⇒ SUPERSEDED skip, NEVER a replace. `readCanonicalText`
      // has no null path — a missing object THROWS (e.g. s3 NoSuchKey) — and a
      // replace over the resulting empty text would WIPE an indexed lane
      // (ingest deletes the lane's turns + tool-calls then inserts parseChunk("")
      // = nothing). `statCanonical`→null is the same "gone" signal the workbench
      // guarded on before the read moved fortress-side.
      const statBytes = await store.statCanonical(readKey);
      if (statBytes === null) {
        logger?.warn("reindexCanonical: canonical missing — superseded, skipped", {
          sessionId: req.key.sessionId,
          agentId,
        });
        return { method: req.method, value: { outcome: "superseded", coveredEnd: 0 } };
      }
      // Cap-gate BEFORE the uncapped whole-object read, so an over-cap canonical
      // costs one stat, not a multi-GiB in-process spike. A >cap canonical stays
      // out of reach (no local RANGE read exists) — throw TYPED. Workbench-side,
      // `canonical_too_large_to_reindex` matches no park token, so it FAILS →
      // dead_letter after maxAttempts: a VISIBLE terminal state (loudly logged +
      // counted in the debt gauge's deadLetter), NOT an invisible park-loop and
      // NOT a silent "complete". Only the corpus's rare >128 MiB outliers reach
      // here; the reconciler deep-verify sweep is the out-of-band backstop for
      // everything ≤128 MiB. Mirrors the sweep's own cap-gate (reconciler.ts ~1775).
      if (statBytes > maxCanonicalBytes()) {
        logger?.warn("reindexCanonical: canonical exceeds the re-index read cap — fails → dead_letter", {
          sessionId: req.key.sessionId,
          agentId,
          statBytes,
          cap: maxCanonicalBytes(),
        });
        throw new Error("canonical_too_large_to_reindex");
      }
      const chunkText = await store.readCanonicalText(readKey);
      // Empty/whitespace ⇒ SUPERSEDED skip: parseChunk("") yields no turns, so a
      // replace would DELETE the lane's turns + tool-calls and insert nothing —
      // wiping an indexed lane. (The workbench guarded this too — trim()==="" →
      // return — so moving the read here moves the guard here.)
      if (chunkText.trim().length === 0) {
        logger?.warn("reindexCanonical: canonical empty — superseded, skipped", {
          sessionId: req.key.sessionId,
          agentId,
          statBytes,
        });
        return { method: req.method, value: { outcome: "superseded", coveredEnd: 0 } };
      }
      // Non-empty but yielding NOTHING TO INDEX ⇒ SUPERSEDED skip too. Two shapes
      // reach this: corrupt/truncated JSONL whose every line fails to parse, AND a
      // canonical holding only NON-message records (summary/system/file-history/
      // blank-reasoning) that `classifyChunk` emits no turns for. A replace over
      // either would DELETE the lane's indexed turns + tool-calls and insert those
      // empty arrays — the SAME wipe the empty guard prevents, reached by a
      // non-empty byte string. Gate on the EXACT quantity the replace inserts
      // (turns + tool-calls), NOT `eventCount` — eventCount counts every parseable
      // line, including the non-message records that index to nothing, so it would
      // miss the second shape and let it wipe. A canonical with nothing to index
      // loses nothing by being skipped. (Parses a second time on the apply path
      // below; a re-index is a background repair, so the extra parse is acceptable
      // for the no-wipe guarantee.)
      const parsed = parseChunk(chunkText);
      if (parsed.turns.length === 0 && parsed.toolCalls.length === 0) {
        logger?.warn("reindexCanonical: canonical parses to nothing indexable — superseded, skipped", {
          sessionId: req.key.sessionId,
          agentId,
          statBytes,
        });
        return { method: req.method, value: { outcome: "superseded", coveredEnd: 0 } };
      }
      if (!resolveDb()) throw new Error("postgres_not_ready");
      // Record the intent BEFORE the PG phase — an abandoned/failed re-index must
      // leave it OPEN (the guarantor's signal), exactly as the inline commit paths.
      await noteChunkIntent(req.key, req.chunkId, statBytes, agentId);
      // Stay in the OBJECT (stat) byte-domain: totalBytes = the stat size we gated
      // on, NOT Buffer.byteLength(chunkText). `ingestCommit` stamps
      // bytes_uploaded = totalBytes on a replace, and the workbench's fence is in
      // the object domain; a decoded length diverges from the object size on a
      // non-UTF-8 canonical and would mismatch the fence every attempt (→ a
      // spurious dead-letter). This is exactly what the inline sync-replace sends
      // today (totalBytes = object size), only read fortress-side.
      const outcome = await racePgPhase(
        () =>
          retryOnceOnTransientDbError(() => {
            const h = resolveDb();
            if (!h) throw new Error("db_unavailable:reindex_canonical");
            const base = {
              ingestChannel: TUNNEL_CHANNEL,
              chunkId: req.chunkId,
              replace: req.replace === true,
              chunkText,
              totalBytes: statBytes,
              componentCount: req.componentCount,
              meta: req.meta,
              attribution: req.attribution,
            };
            return agentId !== null
              ? ingestAgentCommit(h, { ...base, key: req.key, agentId })
              : ingestCommit(h, { ...base, key: req.key });
          }),
        "db_unavailable:reindex_canonical",
        logger,
      );
      // Map the ingest outcome to the workbench's fence contract. A genuine apply
      // returns the object-domain covered end so the workbench fences + drops the
      // covered lane jobs.
      if (outcome.applied) {
        return { method: req.method, value: { outcome: "applied", coveredEnd: statBytes } };
      }
      // A genuine no-op the workbench completes WITHOUT a drop: the chunk / all its
      // records were already indexed, so our fence did not move and must not advance.
      if (outcome.reason === "deduped" || outcome.reason === "duplicate_records") {
        return { method: req.method, value: { outcome: "deduped", coveredEnd: statBytes } };
      }
      // no_user / recovered_skip must NOT reach here for a re-index — the session
      // has a user (req.key.userId) and no rebuild/recovered flag is set. If one
      // somehow does, NOTHING was indexed: surface it TYPED so the debt row stays
      // VISIBLE (the workbench fails → backs off → dead-letters, loudly logged)
      // rather than being silently completed and dropped from the backlog gauge.
      throw new Error(`reindex_unexpected_ingest_outcome:${outcome.reason}`);
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
