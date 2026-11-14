// The kinds of message on the connection.
//
// A message is one frame of the protocol package, and its name is the frame's
// `t`. This file sorts every frame into one kind from a closed list, by its
// name and its direction, and says when each kind is carried.
//
// It is the one table that the connection, the counts and the page of what
// leaves all read. So they cannot disagree about what the connection can
// carry, and a frame that is added to the protocol and not to this table is
// dropped and counted, not carried.
//
// "In" is from the control plane to this HX Fortress.

import type { VaultRpcRequest } from "../modules/session-vault/store/rpc";
import type { FortressToHubFrame, HubToFortressFrame } from "../protocol";

export type Direction = "in" | "out";

/** When a kind is carried: always, only while the Agentic Sessions module is on, or
 *  only while session content is allowed on the connection. */
export type CarriedWhen = "always" | "sessions" | "session_content";

export type KindId =
  | "greeting"
  | "heartbeat"
  | "ask"
  | "release"
  | "members"
  | "session_notice"
  | "question"
  | "session_call"
  | "tool_call";

export interface MessageKind {
  id: KindId;
  /** A few words for a page. */
  title: string;
  /** What a message of this kind holds. */
  holds: string;
  when: CarriedWhen;
  /** The frames of this kind that the control plane sends. */
  in: readonly string[];
  /** The frames of this kind that this HX Fortress sends. */
  out: readonly string[];
}

/**
 * The kind of every frame the control plane can send, by the frame's name.
 *
 * The type is the point: it has one key for each frame of the protocol's
 * union. A frame that is added to the protocol and not sorted into a kind here
 * fails the typecheck, and so the repository's checks.
 */
const KIND_OF_FRAME_IN: Record<HubToFortressFrame["t"], KindId> = {
  enrolled: "greeting",
  welcome: "greeting",
  fatal: "greeting",
  heartbeatAck: "heartbeat",
  moduleMessage: "ask",
  moduleAdvertise: "release",
  moduleRemove: "release",
  rosterSync: "members",
  fortressQueryResult: "question",
  fortressQueryError: "question",
  rpc: "session_call",
  mcpRpc: "tool_call",
};

/** The same for every frame this HX Fortress can send. */
const KIND_OF_FRAME_OUT: Record<FortressToHubFrame["t"], KindId> = {
  enroll: "greeting",
  hello: "greeting",
  heartbeat: "heartbeat",
  moduleReply: "ask",
  moduleInstallResult: "release",
  moduleRemoveResult: "release",
  collectionStats: "session_notice",
  hxInvalidate: "session_notice",
  fortressQuery: "question",
  rpcResult: "session_call",
  rpcError: "session_call",
  mcpRpcResult: "tool_call",
  mcpRpcError: "tool_call",
};

function framesOf(map: Record<string, KindId>, id: KindId): string[] {
  return Object.entries(map)
    .filter(([, kind]) => kind === id)
    .map(([frame]) => frame);
}

function kind(id: KindId, when: CarriedWhen, title: string, holds: string): MessageKind {
  return { id, title, holds, when, in: framesOf(KIND_OF_FRAME_IN, id), out: framesOf(KIND_OF_FRAME_OUT, id) };
}

export const MESSAGE_KINDS: readonly MessageKind[] = [
  kind(
    "greeting",
    "always",
    "The greeting",
    "what this HX Fortress says about itself goes out: its version and the version of the protocol " +
      "it speaks, whether it runs in a container, its id and its credential, or its enrollment token " +
      "the first time; and, where they are set, the kind, name and region of its bucket, the address " +
      "of its gateway and the address of its console. Back come the version of the protocol, the " +
      "organization's id and public key, this HX Fortress's id and credential at enrollment, or the " +
      "reason the control plane refused the connection",
  ),
  kind("heartbeat", "always", "Heartbeats", "nothing"),
  kind(
    "ask",
    "always",
    "Asks and their answers",
    "an ask from a module's own list, with a signed grant; an answer of a fixed shape: counts, " +
      "flags, states, times, names and ids",
  ),
  kind(
    "release",
    "always",
    "Release offers and their results",
    "a module, a version, a link, a checksum and a signature; how the release ended. A request " +
      "to remove a module is always refused",
  ),
  kind(
    "members",
    "sessions",
    "The member list",
    "the organization's active members: names, emails, teams and devices",
  ),
  kind(
    "session_notice",
    "sessions",
    "Counts of sessions, and that a session changed",
    "three counts; a user's id",
  ),
  kind(
    "question",
    "sessions",
    "Questions this HX Fortress asks",
    "session ids and counts go out; counts and flags come back",
  ),
  kind(
    "session_call",
    "session_content",
    "Calls that read or write a session",
    "session text and session metadata, in both directions",
  ),
  kind(
    "tool_call",
    "session_content",
    "Calls of this HX Fortress's tools",
    "a tool's name and its arguments; an answer in free text",
  ),
];

const BY_ID: ReadonlyMap<KindId, MessageKind> = new Map(MESSAGE_KINDS.map((entry) => [entry.id, entry] as const));

const BY_FRAME: Record<Direction, ReadonlyMap<string, MessageKind>> = {
  in: new Map(Object.entries(KIND_OF_FRAME_IN).map(([frame, id]) => [frame, BY_ID.get(id) as MessageKind] as const)),
  out: new Map(Object.entries(KIND_OF_FRAME_OUT).map(([frame, id]) => [frame, BY_ID.get(id) as MessageKind] as const)),
};

/** The kind of a frame, or null for a name that belongs to none. */
export function kindOfFrame(frame: unknown, direction: Direction): MessageKind | null {
  return typeof frame === "string" ? (BY_FRAME[direction].get(frame) ?? null) : null;
}

/**
 * Whether session content may travel on the connection.
 *
 * `null` is "not set": the connection then carries what the build before this
 * setting carried, so an install that is older than the setting does not
 * change. `on` and `off` are a choice somebody made for this HX Fortress.
 */
export type SessionContentSetting = "on" | "off" | null;

/** The setting as the status file, a page and an answer name it. `not_set`
 *  is an HX Fortress where nobody chose. */
export const SESSION_CONTENT_STATES = ["on", "off", "not_set"] as const;
export type SessionContentState = (typeof SESSION_CONTENT_STATES)[number];

export function sessionContentState(setting: SessionContentSetting): SessionContentState {
  return setting ?? "not_set";
}

/** What a running HX Fortress carries on its connection. Read at start. */
export interface ConnectionMode {
  /** Whether the Agentic Sessions module is on for this run. */
  sessions: boolean;
  sessionContent: SessionContentSetting;
}

/** The mode of a connection nobody gave one: everything as before. */
export const MODE_AS_BEFORE: ConnectionMode = { sessions: true, sessionContent: null };

/** Whether a kind is carried in a mode. */
export function isCarried(kind: MessageKind, mode: ConnectionMode): boolean {
  if (kind.when === "always") return true;
  // Not set: nothing is refused that the build before this setting carried.
  if (mode.sessionContent === null) return true;
  if (kind.when === "sessions") return mode.sessions;
  return mode.sessionContent === "on";
}

/** The largest frame the connection goes on to read, in bytes. */
export const FRAME_CAP_BYTES = 32 * 1024 * 1024;
/** The largest frame it reads where only the four kinds that are always
 *  carried can arrive: session content off, and Agentic Sessions off. Nothing that is
 *  carried then is large: an ask's arguments, an offer. */
export const FRAME_CAP_FOUR_KINDS_BYTES = 256 * 1024;

/**
 * The cap for a mode. `override` is FORTRESS_MAX_FRAME_BYTES when it is set.
 *
 * The small cap holds where session content is off and Agentic Sessions is off too.
 * With Agentic Sessions on, the member list is carried, and it is one frame that
 * holds every active member: for a large organization that is megabytes. So
 * the cap is the large one then, whatever session content is.
 *
 * The variable can lower the small cap and never raise it. Elsewhere it is
 * the cap, as it was before the setting.
 *
 * A cap bounds what the connection goes on to parse and dispatch. The runtime
 * has received a frame in full by the time its size is known here, so a cap
 * does not bound memory.
 */
export function frameCapBytes(mode: ConnectionMode, override: number | null = null): number {
  const fourKinds = mode.sessionContent === "off" && !mode.sessions;
  if (!fourKinds) return override ?? FRAME_CAP_BYTES;
  return override === null ? FRAME_CAP_FOUR_KINDS_BYTES : Math.min(FRAME_CAP_FOUR_KINDS_BYTES, override);
}

/**
 * Whether a session call and a tool call must carry a grant whatever
 * FORTRESS_TUNNEL_GRANT_ENFORCE says: where session content was switched on.
 * One rule, read by the connection for a session call and by the tool handler
 * for a tool call.
 */
export function grantRequired(mode: ConnectionMode): boolean {
  return mode.sessionContent === "on";
}

/** The word the control plane is told when it sends a session call or a tool
 *  call while session content is off. */
export const SESSION_CONTENT_OFF = "session_content_off";

/**
 * The methods of a session call, as the Agentic Sessions module's own type names
 * them. The type has one key for each method, so a method that is added to
 * the module and not listed here fails the typecheck.
 *
 * The audit record of a refused call names its method from this list, and
 * from nowhere else: a name the control plane invented is recorded as
 * `unknown`.
 */
const SESSION_CALL_METHOD_SET: Record<VaultRpcRequest["method"], true> = {
  signStagingUpload: true,
  readChunkText: true,
  appendChunkToCanonical: true,
  signCanonicalDownload: true,
  readCanonical: true,
  statCanonical: true,
  writeArtifact: true,
  readArtifactText: true,
  listSessionMetadata: true,
  listSessions: true,
  ingestCommit: true,
  ingestAgentCommit: true,
  reindexCanonical: true,
  updateSessionTitle: true,
  deleteSession: true,
  selfTest: true,
};

export type SessionCallMethod = VaultRpcRequest["method"];
export const SESSION_CALL_METHODS = Object.keys(SESSION_CALL_METHOD_SET) as readonly SessionCallMethod[];

/** A session call's method as it may be written to the trail. */
export function sessionCallMethod(method: unknown): SessionCallMethod | "unknown" {
  return typeof method === "string" && Object.hasOwn(SESSION_CALL_METHOD_SET, method)
    ? (method as SessionCallMethod)
    : "unknown";
}

/** Why a frame was dropped without an answer. */
export const DROP_REASONS = ["too_large", "unreadable", "unknown"] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** The name of a frame from the control plane, read from the head of its
 *  text, when it is a name this build knows. Used only to say which frame was
 *  dropped for its size, which is before the frame is parsed. */
export function frameNameInHead(head: string): string | null {
  const name = /"t"\s*:\s*"([A-Za-z]{1,64})"/.exec(head)?.[1];
  return kindOfFrame(name, "in") ? (name as string) : null;
}
