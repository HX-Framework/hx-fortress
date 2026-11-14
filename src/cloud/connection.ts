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
  type MsgReply,
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
} from "../host/types";
import type { GrantClaims } from "../gateway/capability-token";
import { GRANT_REQUIRED_ERROR, isTunnelGrantEnforcing } from "../gateway/capability-token";
import { sanitizeDbError } from "../host/postgres/sanitize";
import { withDeadline } from "../host/with-deadline";
import { persistSigningKeyPin, type PinnedSigningKey } from "../gateway/signing-key-store";
import { vaultRpcPurpose, type VaultAuthz } from "../modules/session-vault/store/rpc";
import type { FrameCounter } from "./counts";
import type { CloudCredential, CredentialStore } from "./credentials";
import {
  FortressQueryRegistry,
  FortressQueryUnavailable,
  isFortressQueryAnswer,
  type FortressQueryAnswerFrame,
} from "./fortress-query";
import {
  frameCapBytes,
  isCarried,
  kindOfFrame,
  MODE_AS_BEFORE,
  SESSION_CONTENT_OFF,
  sessionCallMethod,
  type ConnectionMode,
} from "./kinds";
import type { FortressQueryPayload, FortressQueryResultPayload } from "../protocol";

export const SUPPORTED_PROTOCOL_VERSION = 1;

const HEARTBEAT_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// MC-2517 · hard ceiling for ONE tool call over the connection. A fortress tool that
// stalls (e.g. a wedged upstream the per-tool bounds didn't catch) must return a
// typed error BEFORE the control plane's 60s RPC timeout fires, so the failure surfaces
// to the user instead of a silent kill on the control plane's side. Under that 60s with margin;
// the query-embed budget (~33s) sits under this in turn.
const MCP_DISPATCH_DEADLINE_MS = 55_000;
/** FORTRESS_MAX_FRAME_BYTES when it is a positive number, else null. The cap
 *  itself goes with what the connection carries: see `frameCapBytes`. */
function parseFrameCapOverride(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** A frame over the cap is logged at most this often. The control plane
 *  decides how many it sends, and each one is counted either way. */
const OVERSIZE_LOG_MIN_INTERVAL_MS = 60_000;

/** How a release ended, as the control plane is told: the body of a
 *  `moduleInstallResult` frame. */
export type ModuleInstallReport =
  | { moduleId: string; version: string; ok: true }
  | { moduleId: string; version: string; ok: false; error: string };

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
   * and the control plane's button never goes away.
   */
  identity: FortressIdentity | (() => FortressIdentity | Promise<FortressIdentity>);
  // There is no loader here. This connection once took one: an object that
  // fetched a module's CODE from the URL in a `moduleAdvertise` frame and ran
  // it. No daemon ever passed one, and the seam is gone, so no frame on this
  // connection can lead to code being loaded, however it is built.
  /**
   * The ask gate. When present, EVERY `moduleMessage` frame goes to it and to
   * nothing else: the grant, the module's switch, the ask list and both shapes
   * are checked there before a module hears anything.
   *
   * The daemon always passes it, and a test composes the daemon to check that
   * it does. Left out, which only a test of the transport itself does, the
   * frame is dispatched directly, as every build before the gate did.
   */
  asks?: { handle(data: MsgData): Promise<MsgReply | undefined> };
  /**
   * The release shelf. When present, a `moduleAdvertise` frame is an OFFER: it
   * is verified and held for a person on this side to approve, and nothing is
   * installed by its arrival. A `moduleRemove` frame is refused. Left out,
   * both frames are dropped: nothing else here takes them.
   */
  releases?: {
    offer(frame: {
      moduleId?: unknown;
      version?: unknown;
      artifactUrl?: unknown;
      checksum?: unknown;
      signature?: unknown;
    }): Promise<ModuleInstallReport | null>;
    remove(moduleId: unknown): Promise<{ moduleId: string; error: string } | null>;
  };
  /** Called after every successful authentication, the first and each reconnect. */
  onAuthenticated?: () => void;
  /**
   * What this connection carries, read for every frame: whether the Sessions
   * module is on, and whether session content may travel. A frame of a kind
   * that is not carried is refused here, before anything is dispatched.
   *
   * The daemon always passes it. Left out, which only a test of the transport
   * does, the connection carries what every build before the setting did.
   */
  mode?: () => ConnectionMode;
  /** Counts every frame by its name and its direction, and every frame that
   *  was refused or dropped. Left out, nothing is counted. */
  counts?: FrameCounter;
  /** Called when a session call or a tool call was refused because session
   *  content is off, so the refusal reaches the audit trail. `method` is one of
   *  the names this build knows, or `unknown`: never the control plane's text. */
  onRefusedCall?: (frame: "rpc" | "mcpRpc", method: string) => void | Promise<void>;
  /** Persists the org Ed25519 public key the control plane pushes on welcome/enrolled, so
   *  the gateway can verify capability tokens offline. H-2: the store PINS the key
   *  on first sight; a later CHANGE without a valid root proof is rejected. */
  signingKeyStore?: {
    loadRecord(): Promise<PinnedSigningKey | null>;
    saveRecord(record: PinnedSigningKey): Promise<void>;
  };
  /** Verifies the capability GRANT of a session call against the pinned
   *  per-org signing key (H-4). Built in main.ts over
   *  signingKeyStore.pinnedKey() + the enrolled org id. Omit to disable grant
   *  verification (a present grant then fails closed on the vault RPC path). */
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
  /** MC-2430: serves the fortress's MCP tools over the connection (the read
   *  transport for a fortress with no public URL). Omit to disable. */
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

/** Dispatch one tool call from the connection to the fortress tool handler + reply. */
export async function dispatchMcpFrame(
  mcp: { handle(req: McpTunnelRequest): Promise<McpTunnelResult> },
  frame: { t: "mcpRpc"; id: string; req: McpTunnelRequest },
  send: (f: FortressToHubFrame) => void,
  logger: { error: (msg: string, err?: unknown) => void },
): Promise<void> {
  try {
    // MC-2517 · bound the handler so the fortress ALWAYS answers within the budget;
    // a stall returns a typed mcpRpcError (which the agent relays) rather than
    // letting the control plane hit its 60s ceiling and kill the call silently.
    const result = await withDeadline(
      mcp.handle(frame.req),
      MCP_DISPATCH_DEADLINE_MS,
      `fortress mcp handler exceeded ${MCP_DISPATCH_DEADLINE_MS}ms`,
    );
    send({ t: "mcpRpcResult", id: frame.id, result });
  } catch (err) {
    // This error crosses the wire back to the control plane — redact any DSN /
    // signed-URL a DB or driver error could carry before it leaves the fortress.
    const error = sanitizeDbError(err);
    logger.error(`a tool call over the connection failed: ${error}`, err);
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
  /** FORTRESS_MAX_FRAME_BYTES, when it is set. */
  private readonly frameCapOverride: number | null;
  private lastOversizeLogAt = 0;
  private closeResolve: (() => void) | null = null;
  private readonly queries = new FortressQueryRegistry();
  /** Frame kinds already reported as unknown. Logged once each, not per frame. */
  private readonly unknownFrames = new Set<string>();

  constructor(private readonly deps: WsCloudConnectionDeps) {
    this.reconnectMinMs = deps.reconnectMinMs ?? RECONNECT_MIN_MS;
    this.reconnectMaxMs = deps.reconnectMaxMs ?? RECONNECT_MAX_MS;
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
    this.frameCapOverride = parseFrameCapOverride(process.env.FORTRESS_MAX_FRAME_BYTES);
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

  /** What this connection carries now. */
  private mode(): ConnectionMode {
    return this.deps.mode?.() ?? MODE_AS_BEFORE;
  }

  /**
   * The one place a frame leaves this fortress. Returns whether it was sent.
   *
   * A frame of a kind that is not carried now is not sent, and is counted as
   * refused. `answersRefusal` marks the frames that tell the control plane its
   * call was refused: their kind is the one that is not carried, and they are
   * the answer that says so.
   */
  private transmit(ws: WebSocket, frame: FortressToHubFrame, answersRefusal = false): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const kind = kindOfFrame(frame.t, "out");
    if (!kind) return false;
    if (!answersRefusal && !isCarried(kind, this.mode())) {
      this.deps.counts?.refused(frame.t);
      return false;
    }
    ws.send(encodeFrame(frame));
    this.deps.counts?.sent(frame.t);
    return true;
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
      this.transmit(ws, {
        t: "hxInvalidate",
        userExternalId: evt.userExternalId,
        orgExternalId: evt.orgExternalId,
      });
    } catch {
      // Best-effort: a transient send failure just misses one invalidation;
      // the next ingest (or the client's own refetch) recovers the list.
    }
  }

  /** Tell the control plane how a release ended. False when the connection is
   *  not open, so the caller knows the control plane has not heard and tries
   *  again on reconnect. */
  reportModuleInstall(result: ModuleInstallReport): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this._state !== "connected") return false;
    try {
      const frame: FortressToHubFrame = result.ok
        ? { t: "moduleInstallResult", moduleId: result.moduleId, version: result.version, ok: true }
        : {
            t: "moduleInstallResult",
            moduleId: result.moduleId,
            version: result.version,
            ok: false,
            error: result.error,
          };
      return this.transmit(ws, frame);
    } catch {
      return false;
    }
  }

  /**
   * Ask the control plane a bounded question and wait for its answer.
   *
   * Daemon-only, and it NEVER hangs and never invents an answer: no socket, a
   * saturated registry, a close, a reconnect and a control plane too old to
   * recognise the frame all reject with FortressQueryUnavailable. The last of
   * those is the silent case — such a control plane sends nothing at all —
   * which is why the timeout, not an error frame, is what makes it terminate.
   * A question is also not asked while its kind is not carried: that rejects
   * as `offline`, because for the caller the control plane cannot be asked.
   */
  request(
    query: FortressQueryPayload,
    timeoutMs?: number,
  ): Promise<FortressQueryResultPayload> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new FortressQueryUnavailable("offline"));
    }
    const kind = kindOfFrame("fortressQuery", "out");
    if (!kind || !isCarried(kind, this.mode())) {
      this.deps.counts?.refused("fortressQuery");
      return Promise.reject(new FortressQueryUnavailable("offline", "questions are not carried on this connection"));
    }
    const opened = this.queries.open(timeoutMs);
    if (!opened.id) return opened.answer;
    // Typed as the union the daemon SENDS on: the question travels from the
    // fortress to the control plane, and letting the package say so is what
    // keeps this file from agreeing with itself about a direction it does not
    // own.
    const frame: FortressToHubFrame = { t: "fortressQuery", id: opened.id, query };
    try {
      this.transmit(ws, frame);
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
   *  fortress connecting: an omitted field leaves the control plane holding
   *  what it has, which is the documented absent state. */
  private async resolveIdentity(): Promise<FortressIdentity> {
    const source = this.deps.identity;
    if (typeof source !== "function") return source;
    try {
      // BOUNDED. This became an async function that reads ui.json off disk, and
      // it sits on the boot-critical path: `open()` settles only on
      // enrolled/welcome/fatal/close, and the runtime awaits it before starting
      // the HTTP gateway and the session-vault module. A wedged mount (NFS,
      // FUSE, a bind mount whose backing store went away) makes that read never
      // settle, so `hello` is never sent, the control plane never authenticates — and
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

    const send = (frame: FortressToHubFrame, answersRefusal = false): void => {
      this.transmit(ws, frame, answersRefusal);
    };

    ws.addEventListener("open", () => {
      this.backoff = this.reconnectMinMs;
      // A pending enrollment token only survives on disk until enrollment
      // succeeds (onEnrolled clears it), so its presence is the operator's fresh
      // (re-)bootstrap intent and must win over any leftover credentials.json
      // from a previous install — otherwise a stale credential shadows the token
      // and the control plane rejects the stale `hello` with `invalid_credential`.
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
        // the control plane bumps its liveness watchdog on every frame before
        // dispatch, so the reaper never fired on a connection that had said
        // nothing.
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
      const rawBytes = Buffer.byteLength(raw);
      // What is carried is read once for a frame: its cap and its kind are
      // judged by the same answer.
      const mode = this.mode();
      const cap = frameCapBytes(mode, this.frameCapOverride);
      if (rawBytes > cap) {
        this.deps.counts?.dropped("too_large");
        // Named before it is dropped — a method this build knows and the size,
        // from the envelope's head (no transcript bytes) — so a recurring drop
        // is greppable. At most once a minute: every one is counted.
        const now = Date.now();
        if (now - this.lastOversizeLogAt >= OVERSIZE_LOG_MIN_INTERVAL_MS) {
          this.lastOversizeLogAt = now;
          const method = sessionCallMethod(/"method"\s*:\s*"([^"]+)"/.exec(raw.slice(0, 300))?.[1]);
          this.deps.logger.error(
            `dropped a frame from the control plane that is over the cap: method=${method} bytes=${rawBytes} cap=${cap}`,
          );
        }
        return;
      }
      const decoded = safeDecodeFrame<HubToFortressFrame | FortressQueryAnswerFrame>(raw);
      if (!decoded.ok) {
        this.deps.counts?.dropped("unreadable");
        return;
      }
      const kind = kindOfFrame(decoded.frame.t, "in");
      if (!kind) {
        this.deps.counts?.dropped("unknown");
        this.noteUnknownFrame(decoded.frame);
        return;
      }
      if (!isCarried(kind, mode)) {
        this.deps.counts?.refused(decoded.frame.t);
        this.refuseNotCarried(decoded.frame, send);
        return;
      }
      this.deps.counts?.received(decoded.frame.t);
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
      // Correlation ids do not survive a socket: the control plane on the other
      // side of the next one has never heard of them, so anything outstanding is
      // answered now rather than left to its own timeout.
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
        this.deps.logger.error("the connection to the control plane failed");
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
            `Unsupported protocol version from the control plane: ${frame.protocolVersion} (client supports ${SUPPORTED_PROTOCOL_VERSION})`,
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
        this.notifyAuthenticated();
        break;
      }
      case "welcome": {
        if (frame.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
          const error = new Error(
            `Unsupported protocol version from the control plane: ${frame.protocolVersion} (client supports ${SUPPORTED_PROTOCOL_VERSION})`,
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
        this.notifyAuthenticated();
        break;
      }
      case "moduleMessage": {
        // Through the ask gate whenever there is one, and then through nothing
        // else: the gate decides whether a module hears this frame at all.
        const gate = this.deps.asks;
        let reply: MsgReply | undefined;
        if (gate) {
          try {
            reply = await gate.handle(frame.data);
          } catch (error) {
            // The gate answers every frame itself; reaching this is a defect in
            // it. The frame is still refused, and nothing about the defect is
            // sent to the control plane.
            this.deps.logger.error("the ask gate failed on a module message", error);
            const id: unknown = (frame.data as { id?: unknown } | null)?.id;
            reply =
              typeof id === "string" && id.length > 0 && id.length <= 128
                ? { ok: false, error: "failed:internal" }
                : undefined;
          }
        } else {
          reply = await this.deps.dispatcher.dispatch(frame.data);
        }
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
        // but-invalid grant fails closed. An ABSENT grant is admitted only where
        // nobody chose about session content and FORTRESS_TUNNEL_GRANT_ENFORCE
        // is off, so a fortress that is older than the setting keeps working.
        // Where session content was switched on, every call needs its grant.
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
              // handleVaultRpc) — requireScope:false, or every read over the
              // connection would throw `unauthorized` once grants ship. (No-op
              // for ingest writes.)
              const grant = await this.deps.verifyGrant(frame.grant, {
                purpose: vaultRpcPurpose(method),
                requireScope: false,
              });
              authz = { sub: grant.sub, scopeHash: grant.scopeHash };
            } catch {
              send({ t: "rpcError", id: frame.id, error: "unauthorized" });
              break;
            }
          } else if (isTunnelGrantEnforcing() || this.mode().sessionContent === "on") {
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
            this.deps.logger.error(`a session call failed: ${reply.error}`);
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
          // A roster that cannot be stored is not a connection problem: the control
          // plane re-sends the whole set on the next sync, so the console keeps
          // rendering the roster it has and says how old it is.
          this.deps.logger.error("could not apply the roster the control plane sent", err);
        }
        break;
      }
      case "heartbeatAck":
        break;
      case "moduleAdvertise": {
        const { moduleId, version, artifactUrl, checksum } = frame;
        // The detached-signature sidecar rides on `moduleAdvertise.signature`.
        // Read it defensively so an older control plane or protocol without the
        // field still parses (the shelf then refuses the offer as unsigned).
        const signature =
          "signature" in frame && typeof frame.signature === "string"
            ? frame.signature
            : undefined;
        if (this.deps.releases) {
          // An offer, not an install. The shelf verifies it and holds it; what
          // comes back is sent only when the offer was refused outright.
          try {
            const result = await this.deps.releases.offer({
              moduleId,
              version,
              artifactUrl,
              checksum,
              signature,
            });
            if (result) send({ t: "moduleInstallResult", ...result });
          } catch (error) {
            this.deps.logger.error("the release shelf failed on an offer", error);
          }
        }
        break;
      }
      case "moduleRemove": {
        const { moduleId } = frame;
        if (this.deps.releases) {
          // The control plane cannot remove a module. Recorded, and answered with
          // the refusal when the id is one this host can repeat back.
          try {
            const refused = await this.deps.releases.remove(moduleId);
            if (refused) {
              send({
                t: "moduleRemoveResult",
                moduleId: refused.moduleId,
                ok: false,
                error: refused.error,
              });
            }
          } catch (error) {
            this.deps.logger.error("the release shelf failed on a remove", error);
          }
        }
        break;
      }
      case "fatal": {
        this._reason = frame.reason;
        this._message = `The control plane refused the connection: ${frame.reason}`;
        this.deps.logger.error(`the control plane refused the connection: ${frame.reason}`);
        this.stopped = true;
        settle(new Error(this._message));
        this.ws?.close();
        break;
      }
      default: {
        // Not reached from the socket: a frame with a name this build does not
        // know is dropped where it arrives. A caller that hands one in directly
        // gets the same.
        this.noteUnknownFrame(frame);
        break;
      }
    }
  }

  /**
   * A frame with a name this build does not know: a control plane ahead of
   * this fortress. Dropping it is correct — the envelope is additive precisely
   * so an older peer keeps working — but dropping it SILENTLY is how a frame
   * that was supposed to be handled goes unnoticed for a release. Logged once
   * per name, so a frame on every heartbeat cannot become the log.
   *
   * TRUNCATED and CAPPED. The name is peer-chosen text bounded only by the
   * frame size, and a control plane that was taken over is explicitly in this
   * appliance's threat model — an unbounded set keyed on it is memory the peer
   * decides, and a log line the peer writes.
   */
  private noteUnknownFrame(frame: { t?: unknown }): void {
    const name = String(frame.t ?? "unnamed").slice(0, 64);
    if (this.unknownFrames.has(name) || this.unknownFrames.size >= UNKNOWN_FRAME_KINDS_LOGGED) return;
    this.unknownFrames.add(name);
    this.deps.logger.error(
      `ignoring a frame from the control plane that this build does not understand: ${name} (the control plane is newer than this fortress)`,
    );
  }

  /**
   * A frame of a kind that is not carried now. Nothing is dispatched.
   *
   * A call that waits for an answer gets one, so the control plane does not
   * wait for its own timeout: one fixed word, under the id it sent when that
   * is an id this host can repeat back. The refusal is handed on to be
   * recorded. Any other frame has no answer and is dropped. It was counted
   * where it arrived.
   */
  private refuseNotCarried(
    frame: HubToFortressFrame,
    send: (f: FortressToHubFrame, answersRefusal?: boolean) => void,
  ): void {
    if (frame.t !== "rpc" && frame.t !== "mcpRpc") return;
    const id: unknown = (frame as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0 && id.length <= 128) {
      send(
        frame.t === "rpc"
          ? { t: "rpcError", id, error: SESSION_CONTENT_OFF }
          : { t: "mcpRpcError", id, error: SESSION_CONTENT_OFF },
        true,
      );
    }
    const method =
      frame.t === "rpc" ? sessionCallMethod((frame.req as { method?: unknown } | null | undefined)?.method) : "";
    void Promise.resolve()
      .then(() => this.deps.onRefusedCall?.(frame.t, method))
      .catch((error: unknown) => {
        this.deps.logger.error("a refused call could not be recorded", error);
      });
  }

  private notifyAuthenticated(): void {
    try {
      this.deps.onAuthenticated?.();
    } catch (error) {
      this.deps.logger.error("onAuthenticated hook failed", error);
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
