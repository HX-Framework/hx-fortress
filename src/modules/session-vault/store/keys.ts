// M-6 · central, validated object-key builders shared by BOTH stores (GCS + S3).
//
// The session key segments (userId / family / sessionId) originate from a
// capability token or a tunnel RPC — untrusted from the store's point of view. A
// segment carrying "/" or ".." could escape its `${userId}/${family}/${sessionId}`
// prefix and read or clobber another session's (or another user's) objects. Every
// segment is therefore constrained to a conservative charset and rejected if it
// is "." / ".." or empty. The internal path literals (".staging", ".compact-*",
// "log.jsonl") are code-controlled and never pass through assertSegment.

import type { SessionKey } from "./types.js";

const SEG = /^[A-Za-z0-9._-]{1,200}$/;

function assertSegment(v: string, label: string): void {
  // A leading dot is RESERVED for internal artifacts (".staging",
  // ".compact-*", the ".session-vault/" probe prefix — which now carries
  // lifecycle DELETION rules): a key segment that could park customer data
  // under an expiring internal prefix must be structurally impossible, not
  // merely unlikely. Subsumes the "." / ".." traversal rejections.
  if (!SEG.test(v) || v.startsWith(".")) throw new Error(`invalid ${label} segment`);
}

/** Validate a sessionId, which is EITHER a plain colon-free segment OR the agent-
 *  lane composite `${sessionId}:a:${agentId}` (built by the gateway, exactly three
 *  parts with the literal `a` marker in the middle). A plain sessionId (a UUID)
 *  must contain NO `:`, so a crafted multi-colon id ("S:b:c", "S:a:A:B", a stray
 *  ":") can't fabricate a nested prefix or masquerade as an agent lane. */
function assertSessionId(sessionId: string): void {
  if (!sessionId.includes(":")) {
    assertSegment(sessionId, "sessionId");
    return;
  }
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[1] !== "a") {
    throw new Error("invalid sessionId segment");
  }
  assertSegment(parts[0], "sessionId"); // the base session id
  assertSegment(parts[2], "sessionId"); // the agent id (marker `a` is fixed)
}

/** `${userId}/${family}/${sessionId}` with every segment validated (the sessionId
 *  via `assertSessionId` — plain, or the agent-lane composite). */
export function sessionPrefix(k: SessionKey): string {
  assertSegment(k.userId, "userId");
  assertSegment(k.family, "family");
  assertSessionId(k.sessionId);
  return `${k.userId}/${k.family}/${k.sessionId}`;
}

/** The `${userId}/` list prefix for one user's objects, with the segment validated
 *  — parity with the per-object key builders so an untrusted userId can never widen
 *  a listing beyond its own prefix (M-6). */
export function listPrefix(userId: string): string {
  assertSegment(userId, "userId");
  return `${userId}/`;
}

/** The two list prefixes that together cover EVERY object of one session: its
 *  own directory (`…/sid/`) and every agent lane (`…/sid:a:` — sibling
 *  prefixes, not nested). Both are exact-segment shaped: the char after the
 *  session id is `/` or `:`, so a longer sibling id can never match. Callers
 *  pass the BASE session id (no `:a:` composite). */
export function sessionDeletePrefixes(k: SessionKey): [string, string] {
  if (k.sessionId.includes(":")) throw new Error("deleteSession requires the base session id");
  const p = sessionPrefix(k);
  return [`${p}/`, `${p}:a:`];
}

export function stagingObject(k: SessionKey, chunkId: string): string {
  assertSegment(chunkId, "chunkId");
  return `${sessionPrefix(k)}/.staging/${chunkId}.jsonl`;
}

export function canonicalObject(k: SessionKey): string {
  return `${sessionPrefix(k)}/log.jsonl`;
}

/** Inverse of canonicalObject: a bucket object name → its SessionKey, or null if
 *  it isn't a canonical log. `${userId}/${family}/${sessionId}/log.jsonl` — the
 *  sessionId keeps the `${sessionId}:a:${agentId}` agent-lane composite as one
 *  segment. Rejects staging/artifact/other objects (wrong segment count/tail).
 *  Used by the G reconciler's whole-bucket orphan scan. */
export function parseCanonicalKey(objectName: string): SessionKey | null {
  if (!objectName.endsWith("/log.jsonl")) return null;
  const parts = objectName.split("/");
  if (parts.length !== 4 || parts[3] !== "log.jsonl") return null;
  const [userId, family, sessionId] = parts;
  if (!userId || !family || !sessionId) return null;
  return { userId, family, sessionId };
}

// Only these sidecar artifacts may be written/read by name — the `name` on the
// artifact RPC / gateway route is caller-controlled, so an allowlist prevents it
// naming ".staging/…", "log.jsonl", or a traversal path.
const ARTIFACT_ALLOWLIST = new Set(["session.json", "tasks.json", "plan.json"]);

// The workbench also writes/reads a per-run workflow artifact named
// `workflow-<runId>.json` (workflowArtifactName). runId varies per run, so a fixed
// Set can't hold it — a STRICT pattern admits it while the `[A-Za-z0-9_-]` charset
// (no ".", no "/") keeps it traversal-safe just like an assertSegment segment.
const WORKFLOW_ARTIFACT = /^workflow-[A-Za-z0-9_-]{4,200}\.json$/;

/**
 * Every sidecar name a session may carry — the fixed allowlist AND the unbounded
 * per-run workflow class, as ONE predicate.
 *
 * Exported because a second copy of this rule is how objects go missing. A
 * storage migration that walked the three fixed names left every
 * `workflow-<runId>.json` behind in the old bucket, and a verification that
 * compared only canonicals reported that cut as clean. The migration now
 * enumerates what a session's prefix actually holds and asks this function what
 * it is looking at, so a fifth artifact class is carried the day it is admitted
 * here.
 */
export function isSessionArtifactName(name: string): boolean {
  return ARTIFACT_ALLOWLIST.has(name) || WORKFLOW_ARTIFACT.test(name);
}

/** The sidecar names in a raw listing of ONE session's prefix.
 *
 *  A prefix listing carries no delimiter, so it also returns the canonical log
 *  and the internal `.staging/` chunks — neither is a sidecar, and neither is a
 *  name `writeArtifact` would accept. Filtering through the same predicate the
 *  write door uses is what keeps "what is here" and "what may be written here"
 *  from drifting apart. */
export function sessionArtifactNames(objectNames: Iterable<string>, prefix: string): string[] {
  const names = new Set<string>();
  for (const objectName of objectNames) {
    if (!objectName.startsWith(prefix)) continue;
    const name = objectName.slice(prefix.length);
    if (isSessionArtifactName(name)) names.add(name);
  }
  return [...names].sort();
}

export function artifactObject(k: SessionKey, name: string): string {
  if (!isSessionArtifactName(name)) {
    throw new Error(`artifact not allowed: ${name}`);
  }
  return `${sessionPrefix(k)}/${name}`;
}
