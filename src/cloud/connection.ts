import {
  encodeFrame,
  safeDecodeFrame,
  type CollectionStats,
  type FortressIdentity,
  type FortressToHubFrame,
  type HubToFortressFrame,
  type KeyProof,
  type McpTunnelRequest,
  type McpTunnelResult,
  type MsgData,
  type RosterSyncPayload,
} from "../protocol";
import type {
  CloudConnection,
  ConnectionState,
  ConnectionStatusSnapshot,
  FortressConfig,
  HostLogger,
  HxIngestNotification,
  MessageDispatcher,
  ModuleLifecycleHandler,
} from "../host/types";
import type { GrantClaims } from "../gateway/capability-token";
import { GRANT_REQUIRED_ERROR, isTunnelGrantEnforcing } from "../gateway/capability-token";
import { sanitizeDbError } from "../host/postgres/sanitize";
import { withDeadline } from "../host/with-deadline";
import { persistSigningKeyPin, type PinnedSigningKey } from "../gateway/signing-key-store";
import { vaultRpcPurpose, type VaultAuthz } from "../modules/session-vault/store/rpc";
import type { CloudCredential, CredentialStore } from "./credentials";
import {
  FortressQueryRegistry,
  FortressQueryUnavailable,
  isFortressQueryAnswer,
  type FortressQueryAnswerFrame,
} from "./fortress-query";
import type { FortressQueryPayload, FortressQueryResultPayload } from "../protocol";

export const SUPPORTED_PROTOCOL_VERSION = 1;

const HEARTBEAT_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// MC-2517 · hard ceiling for ONE reverse-tunnel MCP call. A fortress tool that
// stalls (e.g. a wedged upstream the per-tool bounds didn't catch) must return a
// typed error BEFORE the workbench's 60s RPC timeout fires, so the failure surfaces
// to the user instead of a silent workbench-side kill. Under that 60s with margin;
// the query-embed budget (~33s) sits under this in turn.
const MCP_DISPATCH_DEADLINE_MS = 55_000;
// Low · drop any frame larger than this before parsing it (DoS guard).
const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;

function parseMaxFrameBytes(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_FRAME_BYTES;
}

export interface WsCloudConnectionDeps {
  dispatcher: MessageDispatcher;
  credentialStore: CredentialStore;
  logger: HostLogger;
  /**
   * What this fortress says about itself in `hello` / `enroll`.
   *
   * EVALUATED PER CONNECTION ATTEMPT when it is a function, because two of its
   * fields are operator settings that change while the daemon runs: a frozen
   * snapshot makes `ui sso off` and `ui disable` unable to clear the advertised
   * console URL — the next reconnect re-sends whatever boot happened to read,
   * and the workbench button never goes away.
   */
  identity: FortressIdentity | (() => FortressIdentity | Promise<FortressIdentity>);
  moduleLoader?: ModuleLifecycleHandler;
  /** Persists the org Ed25519 public key the hub pushes on welcome/enrolled, so
   *  the gateway can verify capability tokens offline. H-2: the store PINS the key
   *  on first sight; a later CHANGE without a valid root proof is rejected. */
  signingKeyStore?: {
    loadRecord(): Promise<PinnedSigningKey | null>;
    saveRecord(record: PinnedSigningKey): Promise<void>;
  };
  /** Verifies a tunnel capability GRANT against the pinned per-org signing key
   *  (H-4). Built in main.ts over signingKeyStore.pinnedKey() + the enrolled org
   *  id. Omit to disable tunnel grant verification (a present grant then fails
   *  closed on the vault RPC path). */
  verifyGrant?: (
    token: string,
    opts: { purpose: "ingest" | "read"; requireScope?: boolean },
  ) => Promise<GrantClaims>;
  enrollToken?: string;
  /** Called once immediately after a successful enrollment and credential save.
   *  Use to clear the pending enrollment token and propagate identity to modules. */
  onEnrolled?: (cred: CloudCredential) => Promise<void> | void;
  heartbeatMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** MC-2430 tunnel-MCP: serves the fortress's MCP tools over the reverse
   *  tunnel (the read transport for a fortress with no public URL). Omit to disable. */
  mcp?: { handle(req: McpTunnelRequest): Promise<McpTunnelResult> };
  /** MC-2368: computes the fortress's collection counts, piggybacked onto the
   *  heartbeat (throttled). Returns null when the DB isn't ready. Omit to disable. */
  collectionStats?: () => Promise<CollectionStats | null>;
  /** Receives one rosterSync: the organization's active members and their device
   *  inventory. Omit and the frame is accepted and dropped — which is what an
   *  older build did to every frame it did not know, silently. */
  onRoster?: (roster: RosterSyncPayload) => Promise<void>;
}

/** How long composing the identity may take before the connection proceeds with
 *  a degraded one. Well inside any reconnect cadence: the alternative is a boot
 *  that never completes. */
const IDENTITY_DEADLINE_MS = 2_000;

/** How many distinct unknown frame kinds are worth naming once each. The set
 *  exists so a frame on every heartbeat cannot become the log; the cap exists so
 *  a peer choosing a fresh discriminator per frame cannot become the heap. */
const UNKNOWN_FRAME_KINDS_LOGGED = 32;

// MC-2517 fortress dispatch ceiling — withDeadline now lives in
// ../host/with-deadline (shared with the vault RPC PG-phase races).

/** Dispatch one reverse-tunnel MCP request to the fortress tool handler + reply. */
export async function dispatchMcpFrame(
  mcp: { handle(req: McpTunnelRequest): Promise<McpTunnelResult> },
  frame: { t: "mcpRpc"; id: string; req: McpTunnelRequest },
  send: (f: FortressToHubFrame) => void,
  logger: { error: (msg: string, err?: unknown) => void },
): Promise<void> {
  try {
    // MC-2517 · bound the handler so the fortress ALWAYS answers within the budget;
    // a stall returns a typed mcpRpcError (which the agent relays) rather than
    // letting the workbench hit its 60s ceiling and kill the call silently.
    const result = await withDeadline(
      mcp.handle(frame.req),
      MCP_DISPATCH_DEADLINE_MS,
      `fortress mcp handler exceeded ${MCP_DISPATCH_DEADLINE_MS}ms`,
    );
    send({ t: "mcpRpcResult", id: frame.id, result });
  } catch (err) {
    // This error crosses the wire back to the hub/agent — redact any DSN /
    // signed-URL a DB or driver error could carry before it leaves the fortress.
    const error = sanitizeDbError(err);
    logger.error(`mcp tunnel error: ${error}`, err);
    send({ t: "mcpRpcError", id: frame.id, error });
  }
}

export class WsCloudConnection implements CloudConnection {
  private _state: ConnectionState = "offline";
  private _reason: string | null = null;
  private _message: string | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private backoff: number;
  // The pending enrollment token, consumed on the first successful enroll and
  // then cleared so later reconnects authenticate with the saved credential
  // (the token is one-time — re-sending a consumed one would be rejected).
  private activeEnrollToken: string | null;
  private readonly heartbeatMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxFrameBytes: number;
  private closeResolve: (() => void) | null = null;
  private readonly queries = new FortressQueryRegistry();
  /** Frame kinds already reported as unknown. Logged once each, not per frame. */
  private readonly unknownFrames = new Set<string>();

  constructor(private readonly deps: WsCloudConnectionDeps) {
    this.reconnectMinMs = deps.reconnectMinMs ?? RECONNECT_MIN_MS;
    this.reconnectMaxMs = deps.reconnectMaxMs ?? RECONNECT_MAX_MS;
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
    this.maxFrameBytes = parseMaxFrameBytes(process.env.FORTRESS_MAX_FRAME_BYTES);
    this.backoff = this.reconnectMinMs;
    this.activeEnrollToken = deps.enrollToken ?? null;
  }

  state(): ConnectionState {
    return this._state;
  }

  status(): ConnectionStatusSnapshot {
    return {
      state: this._state,
      reason: this._reason,
      message: this._message,
    };
  }

  open(config: FortressConfig): Promise<void> {
    this._state = "connecting";
    this._reason = null;
    this._message = null;
    this.stopped = false;
    this.backoff = this.reconnectMinMs;
    return new Promise<void>((resolve, reject) => {
      void this.dial(config, resolve, reject);
    });
  }

  notifyIngest(evt: HxIngestNotification): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        encodeFrame({
          t: "hxInvalidate",
          userExternalId: evt.userExternalId,
          orgExternalId: evt.orgExternalId,
        }),
      );
    } catch {
      // Best-effort: a transient send failure just misses one invalidation;
      // the next ingest (or the client's own refetch) recovers the list.
    }
  }

  /**
   * Ask the hub a bounded question and wait for its answer.
   *
   * Daemon-only, and it NEVER hangs and never invents an answer: no socket, a
   * saturated registry, a close, a reconnect and a hub too old to recognise the
   * frame all reject with FortressQueryUnavailable. The last of those is the
   * silent case — an unupgraded hub sends nothing at all — which is why the
   * timeout, not an error frame, is what makes it terminate.
   */
  request(
    query: FortressQueryPayload,
    timeoutMs?: number,
  ): Promise<FortressQueryResultPayload> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new FortressQueryUnavailable("offline"));
    }
    const opened = this.queries.open(timeoutMs);
    if (!opened.id) return opened.answer;
    // Typed as the union the daemon SENDS on: the question travels
    // fortress→hub, and letting the package say so is what keeps this file from
    // agreeing with itself about a direction it does not own.
    const frame: FortressToHubFrame = { t: "fortressQuery", id: opened.id, query };
    try {
      ws.send(encodeFrame(frame));
    } catch (err) {
      this.queries.settle({
        t: "fortressQueryError",
        id: opened.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return opened.answer;
  }

  close(): Promise<void> {
    this.stopped = true;
    this._state = "closing";
    this.clearHeartbeat();
    this.queries.drain("closed");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this._state = "offline";
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.closeResolve = resolve;
      ws.close();
    });
  }

  /** The identity as of THIS attempt. A failure to read it must not stop the
   *  fortress connecting: an omitted field leaves the hub holding what it has,
   *  which is the documented absent state. */
  private async resolveIdentity(): Promise<FortressIdentity> {
    const source = this.deps.identity;
    if (typeof source !== "function") return source;
    try {
      // BOUNDED. This became an async function that reads ui.json off disk, and
      // it sits on the boot-critical path: `open()` settles only on
      // enrolled/welcome/fatal/close, and the runtime awaits it before starting
      // the HTTP gateway and the session-vault module. A wedged mount (NFS,
      // FUSE, a bind mount whose backing store went away) makes that read never
      // settle, so `hello` is never sent, the hub never authenticates — and
      // nothing times out, because the heartbeat keeps the socket alive past the
      // reaper. Total silent ingest outage with the status stuck at `starting`.
      // The degraded identity below is exactly what this arm is for.
      return await withDeadline(
        Promise.resolve(source()),
        IDENTITY_DEADLINE_MS,
        "composing the fortress identity took too long",
      );
    } catch (err) {
      this.deps.logger.error("could not compose the fortress identity for this connection", err);
      return { version: "unknown", protocolVersion: 0 };
    }
  }

  private async dial(
    config: FortressConfig,
    onFirstConnect: () => void,
    onFirstFail: (error: Error) => void,
  ): Promise<void> {
    if (this.stopped) {
      this._state = "offline";
      return;
    }

    let firstSettled = false;
    const settle = (error?: Error): void => {
      if (firstSettled) return;
      firstSettled = true;
      if (error) onFirstFail(error);
      else onFirstConnect();
    };

    let cred: CloudCredential | null;
    try {
      cred = await this.deps.credentialStore.load();
    } catch (err) {
      this._state = "offline";
      settle(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!cred && !this.activeEnrollToken) {
      this._state = "offline";
      settle(new Error("No Fortress credentials and no enrollment token — cannot connect"));
      return;
    }

    // close() may have landed while the credential load was in flight. The check
    // at the top of dial() ran before that await, so without this one a reconnect
    // opens a socket AFTER the caller was told the connection was closed — and
    // nothing ever closes it, because close() already saw the old socket.
    if (this.stopped) {
      this._state = "offline";
      return;
    }

    const ws = new WebSocket(config.cloud.url);
    this.ws = ws;

    const send = (frame: FortressToHubFrame): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame));
    };

    ws.addEventListener("open", () => {
      this.backoff = this.reconnectMinMs;
      // A pending enrollment token only survives on disk until enrollment
      // succeeds (onEnrolled clears it), so its presence is the operator's fresh
      // (re-)bootstrap intent and must win over any leftover credentials.json
      // from a previous install — otherwise a stale credential shadows the token
      // and the hub rejects the stale `hello` with `invalid_credential`.
      void (async (): Promise<void> => {
        const identity = await this.resolveIdentity();
        if (this.activeEnrollToken) {
          send({ t: "enroll", enrollToken: this.activeEnrollToken, ...identity });
        } else if (cred) {
          send({
            t: "hello",
            fortressId: cred.fortressId,
            credential: cred.credential,
            ...identity,
          });
        }
        // The heartbeat starts only once the greeting is actually on the wire.
        // Started outside this closure it kept an UNAUTHENTICATED socket alive —
        // the hub bumps its liveness watchdog on every frame before dispatch, so
        // the reaper never fired on a connection that had said nothing.
        let lastStatsAt = 0;
      const STATS_MIN_INTERVAL_MS = 60_000;
      this.heartbeatTimer = setInterval(() => {
        send({ t: "heartbeat" });
        // MC-2368: piggyback collection counts on the heartbeat tick — no second
        // timer to leak/stack on reconnect. Throttled + best-effort so a slow or
        // failed compute never delays the liveness ping.
        const now = Date.now();
        if (this.deps.collectionStats && now - lastStatsAt >= STATS_MIN_INTERVAL_MS) {
          lastStatsAt = now;
          void this.deps
            .collectionStats()
            .then((stats) => {
              if (stats) send({ t: "collectionStats", stats });
            })
            .catch(() => {});
        }
        }, this.heartbeatMs);
      })();
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      // Drop an oversized frame BEFORE parsing it (DoS guard), and use the
      // non-throwing decoder so a malformed envelope returns without dispatch
      // instead of throwing out of the read loop. Measure BYTES (UTF-8), not
      // `raw.length` (UTF-16 code units), so a multi-byte payload can't sneak past
      // the byte ceiling.
      if (Buffer.byteLength(raw) > this.maxFrameBytes) return;
      const decoded = safeDecodeFrame<HubToFortressFrame | FortressQueryAnswerFrame>(raw);
      if (!decoded.ok) return;
      // Answers are correlated, not dispatched: they belong to a caller holding a
      // promise, and an unknown id is dropped rather than routed anywhere.
      if (isFortressQueryAnswer(decoded.frame)) {
        this.queries.settle(decoded.frame);
        return;
      }
      void this.handleFrame(decoded.frame, send, settle);
    });

    ws.addEventListener("close", () => {
      this.clearHeartbeat();
      // Correlation ids do not survive a socket: the hub on the other side of the
      // next one has never heard of them, so anything outstanding is answered
      // now rather than left to its own timeout.
      this.queries.drain(this.stopped ? "closed" : "offline");
      if (this.stopped) {
        this._state = "offline";
        const resolve = this.closeResolve;
        this.closeResolve = null;
        resolve?.();
        settle(new Error("Connection closed before authentication completed"));
        return;
      }
      this._state = "connecting";
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.reconnectMaxMs);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.dial(config, () => {}, () => {});
      }, wait);
    });

    ws.addEventListener("error", () => {
      if (!firstSettled) {
        this.deps.logger.error("Fortress cloud connection error");
      }
    });
  }

  private async handleFrame(
    frame: HubToFortressFrame,
    send: (f: FortressToHubFrame) => void,
    settle: (error?: Error) => void,
  ): Promise<void> {
    switch (frame.t) {
      case "enrolled": {
        if (frame.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
          const error = new Error(
            `Unsupported protocol version from hub: ${frame.protocolVersion} (client supports ${SUPPORTED_PROTOCOL_VERSION})`,
          );
          this.deps.logger.error(error.message);
          this.stopped = true;
          settle(error);
          this.ws?.close();
          return;
        }
        await this.persistSigningKey(frame.orgId, frame.signingPublicKey, frame.keyProof);
        // The one-time token is now spent; reconnects must authenticate with the
        // saved credential via hello, never re-send the consumed token.
        this.activeEnrollToken = null;
        const cred: CloudCredential = {
          orgId: frame.orgId,
          fortressId: frame.fortressId,
          credential: frame.credential,
        };
        try {
          await this.deps.credentialStore.save(cred);
        } catch (err) {
          this.deps.logger.error("Failed to save Fortress credentials", err);
        }
        try {
          await this.deps.onEnrolled?.(cred);
        } catch (err) {
          this.deps.logger.error("onEnrolled hook failed", err);
        }
        this._reason = null;
        this._message = null;
        this._state = "connected";
        settle();
        break;
      }
      case "welcome": {
        if (frame.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
          const error = new Error(
            `Unsupported protocol version from hub: ${frame.protocolVersion} (client supports ${SUPPORTED_PROTOCOL_VERSION})`,
          );
          this.deps.logger.error(error.message);
          this.stopped = true;
          settle(error);
          this.ws?.close();
          return;
        }
        await this.persistSigningKey(frame.orgId, frame.signingPublicKey, frame.keyProof);
        this._reason = null;
        this._message = null;
        this._state = "connected";
        settle();
        break;
      }
      case "moduleMessage": {
        const reply = await this.deps.dispatcher.dispatch(frame.data);
        if (reply) {
          send({ t: "moduleReply", id: frame.data.id, reply });
        }
        break;
      }
      case "rpc": {
        const method = (frame.req as { method?: string }).method ?? "";
        // H-4 · authorize the vault RPC with its cloud-signed grant. selfTest is
        // an object-free liveness probe and is never gated. A present grant is
        // fully verified and its principal bound into the RPC (authz); a present-
        // but-invalid grant fails closed. An ABSENT grant is admitted only while
        // FORTRESS_TUNNEL_GRANT_ENFORCE is off, so current traffic keeps working.
        let authz: VaultAuthz | undefined;
        if (method !== "selfTest") {
          if (frame.grant) {
            if (!this.deps.verifyGrant) {
              send({ t: "rpcError", id: frame.id, error: "unauthorized" });
              break;
            }
            try {
              // Vault RPCs are OWN-OBJECT: a read grant is sub-bound with NO
              // scopeHash (the boundary is key.userId === grant.sub, enforced in
              // handleVaultRpc) — requireScope:false, or every tunnel read would
              // throw `unauthorized` once grants ship. (No-op for ingest writes.)
              const grant = await this.deps.verifyGrant(frame.grant, {
                purpose: vaultRpcPurpose(method),
                requireScope: false,
              });
              authz = { sub: grant.sub, scopeHash: grant.scopeHash };
            } catch {
              send({ t: "rpcError", id: frame.id, error: "unauthorized" });
              break;
            }
          } else if (isTunnelGrantEnforcing()) {
            // Absent grant under enforcement — the SAME code the HTTP gateway + MCP
            // layer use (a present-but-invalid grant stays `unauthorized` above).
            send({ t: "rpcError", id: frame.id, error: GRANT_REQUIRED_ERROR });
            break;
          }
        }
        const msgData: MsgData & { authz?: VaultAuthz } = {
          module: "session_vault",
          id: frame.id,
          kind: "request",
          payload: frame.req,
        };
        if (authz) msgData.authz = authz;
        const reply = await this.deps.dispatcher.dispatch(msgData);
        if (reply) {
          if (reply.ok) {
            send({ t: "rpcResult", id: frame.id, result: reply.payload });
          } else {
            this.deps.logger.error(`vault RPC error: ${reply.error}`);
            send({ t: "rpcError", id: frame.id, error: reply.error });
          }
        }
        break;
      }
      case "mcpRpc": {
        if (this.deps.mcp) await dispatchMcpFrame(this.deps.mcp, frame, send, this.deps.logger);
        break;
      }
      case "rosterSync": {
        if (!this.deps.onRoster) break;
        try {
          await this.deps.onRoster(frame.roster);
        } catch (err) {
          // A roster that cannot be stored is not a connection problem: the hub
          // re-sends the whole set on the next sync, so the console keeps
          // rendering the roster it has and says how old it is.
          this.deps.logger.error("could not apply the roster let.ai sent", err);
        }
        break;
      }
      case "heartbeatAck":
        break;
      case "moduleAdvertise": {
        const { moduleId, version, artifactUrl, checksum } = frame;
        // The detached-signature sidecar rides on `moduleAdvertise.signature`.
        // Read it defensively so an older hub/protocol without the field still
        // parses (the loader then fails closed only when enforcing).
        const signature =
          "signature" in frame && typeof frame.signature === "string"
            ? frame.signature
            : undefined;
        if (this.deps.moduleLoader) {
          try {
            await this.deps.moduleLoader.install({
              moduleId,
              version,
              artifactUrl,
              checksum,
              signature,
            });
            send({ t: "moduleInstallResult", moduleId, version, ok: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logger.error(`Failed to install module: ${moduleId}`, error);
            send({ t: "moduleInstallResult", moduleId, version, ok: false, error: message });
          }
        }
        break;
      }
      case "moduleRemove": {
        const { moduleId } = frame;
        if (this.deps.moduleLoader) {
          try {
            await this.deps.moduleLoader.uninstall(moduleId);
            send({ t: "moduleRemoveResult", moduleId, ok: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logger.error(`Failed to remove module: ${moduleId}`, error);
            send({ t: "moduleRemoveResult", moduleId, ok: false, error: message });
          }
        }
        break;
      }
      case "fatal": {
        this._reason = frame.reason;
        this._message = `Hub rejected connection: ${frame.reason}`;
        this.deps.logger.error(`Fortress hub rejected connection: ${frame.reason}`);
        this.stopped = true;
        settle(new Error(this._message));
        this.ws?.close();
        break;
      }
      default: {
        // A hub ahead of this fortress. Dropping it is correct — the envelope is
        // additive precisely so an older peer keeps working — but dropping it
        // SILENTLY is how a frame that was supposed to be handled goes unnoticed
        // for a release. Logged once per kind, so a frame on every heartbeat
        // cannot become the log.
        // TRUNCATED and CAPPED. The discriminator is peer-chosen text bounded
        // only by the frame size, and a compromised hub is explicitly in this
        // appliance's threat model — an unbounded set keyed on it is memory the
        // peer decides, and a log line the peer writes.
        const kind = String((frame as { t?: unknown }).t ?? "unnamed").slice(0, 64);
        if (!this.unknownFrames.has(kind)) {
          if (this.unknownFrames.size < UNKNOWN_FRAME_KINDS_LOGGED) {
            this.unknownFrames.add(kind);
            this.deps.logger.error(
              `ignoring a hub frame this build does not understand: ${kind} (the hub is newer than this fortress)`,
            );
          }
        }
        break;
      }
    }
  }

  private async persistSigningKey(
    orgId: string,
    signingPublicKey?: string,
    keyProof?: KeyProof,
  ): Promise<void> {
    if (!signingPublicKey) return;
    const store = this.deps.signingKeyStore;
    if (!store) return;
    try {
      // H-2 pin-floor: pin on first sight; reject a later CHANGE that lacks a
      // valid root proof (keeps the existing pin, logs signing_key_rotation_rejected).
      await persistSigningKeyPin({
        store,
        orgId,
        incomingKey: signingPublicKey,
        keyProof,
        log: (msg, fields) => this.deps.logger.error(msg, fields),
      });
    } catch (err) {
      this.deps.logger.error("Failed to persist org signing key", err);
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
