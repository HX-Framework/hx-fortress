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
// "In" is from the control plane to this fortress.

import type { FortressToHubFrame, HubToFortressFrame } from "../protocol";

export type Direction = "in" | "out";

/** When a kind is carried: always, only while the Sessions module is on, or
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
  /** The frames of this kind that this fortress sends. */
  out: readonly string[];
}

/**
 * The kind of every frame the control plane can send, by the frame's name.
 *
 * The type is the point: it has one key for each frame of the protocol's
 * union. A frame that is added to the protocol and not sorted into a kind here
 * stops this file from compiling.
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

/** The same for every frame this fortress can send. */
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
    "this fortress's version, its id and its credential go out; the organization's public key " +
      "comes back, or the reason the control plane refused the connection",
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
    "Questions this fortress asks",
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
    "Calls of this fortress's tools",
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
 * change. `on` and `off` are a choice somebody made for this fortress.
 */
export type SessionContentSetting = "on" | "off" | null;

/** What a running fortress carries on its connection. Read at start. */
export interface ConnectionMode {
  /** Whether the Sessions module is on for this run. */
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

/** The largest frame the connection takes in, in bytes. */
export const FRAME_CAP_BYTES = 32 * 1024 * 1024;
/** The largest frame it takes in while session content is off. Nothing that
 *  is carried then is large: an ask's arguments, an offer, a member list. */
export const FRAME_CAP_WITHOUT_SESSION_CONTENT_BYTES = 256 * 1024;

/**
 * The cap for a mode. `override` is FORTRESS_MAX_FRAME_BYTES when it is set:
 * it can lower the cap of a mode, and never raise the cap that goes with
 * session content being off.
 */
export function frameCapBytes(mode: ConnectionMode, override: number | null = null): number {
  const own = mode.sessionContent === "off" ? FRAME_CAP_WITHOUT_SESSION_CONTENT_BYTES : FRAME_CAP_BYTES;
  if (override === null) return own;
  return mode.sessionContent === "off" ? Math.min(own, override) : override;
}

/** The word the control plane is told when it sends a session call or a tool
 *  call while session content is off. */
export const SESSION_CONTENT_OFF = "session_content_off";

/**
 * The methods of a session call. The audit record of a refused call names its
 * method from this list, and from nowhere else: a name the control plane
 * invented is recorded as `unknown`. A test holds this list to the methods the
 * Sessions module serves.
 */
export const SESSION_CALL_METHODS: readonly string[] = [
  "signStagingUpload",
  "readChunkText",
  "appendChunkToCanonical",
  "signCanonicalDownload",
  "readCanonical",
  "statCanonical",
  "writeArtifact",
  "readArtifactText",
  "listSessionMetadata",
  "listSessions",
  "ingestCommit",
  "ingestAgentCommit",
  "reindexCanonical",
  "updateSessionTitle",
  "deleteSession",
  "selfTest",
];

/** A session call's method as it may be written to the trail. */
export function sessionCallMethod(method: unknown): string {
  return typeof method === "string" && SESSION_CALL_METHODS.includes(method) ? method : "unknown";
}

/** Why a frame was dropped without an answer. */
export type DropReason = "too_large" | "unreadable" | "unknown";
