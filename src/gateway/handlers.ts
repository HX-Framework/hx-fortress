// Gateway request handlers — thin wrappers over the session_vault SessionStore,
// reproducing the cloud hx-gateway's upload/read JSON so hx-client reuses its
// pipeline with only a base-URL swap. No PG bookkeeping lives here: in
// fortress-direct mode the customer's Fortress owns storage; let.ai keeps only
// discovery + auth.
import type { SessionMetadata, SessionStore, SessionKey } from "../modules/session-vault/store/types";

export interface AppendUrlInput {
  userId: string;
  family: string;
  sessionId: string;
  chunkId: string;
}

export interface AppendUrlOutput {
  chunkId: string;
  uploadUrl: string;
  objectName: string;
  expiresAt: string;
}

export interface CommitInput {
  userId: string;
  family: string;
  sessionId: string;
  chunkId: string;
  replace?: boolean;
}

export interface CommitOutput {
  ok: true;
  totalBytes: number;
  componentCount: number;
}

export interface AgentAppendUrlInput extends AppendUrlInput {
  agentId: string;
}

export interface AgentCommitInput extends CommitInput {
  agentId: string;
}

export interface CanonicalDownloadInput {
  userId: string;
  family: string;
  sessionId: string;
}

export interface CanonicalDownloadOutput {
  url: string;
  expiresAt: string;
}

export interface ArtifactReadInput extends CanonicalDownloadInput {
  name: string;
}

export interface ListSessionMetadataInput {
  userId: string;
}

function keyOf(i: { userId: string; family: string; sessionId: string }): SessionKey {
  return { userId: i.userId, family: i.family, sessionId: i.sessionId };
}

// Child execution lanes share the parent's storage prefix under a composite
// sessionId — identical scheme to the cloud's agentStoreKey.
function agentKeyOf(i: AgentAppendUrlInput | AgentCommitInput): SessionKey {
  return { userId: i.userId, family: i.family, sessionId: `${i.sessionId}:a:${i.agentId}` };
}

export async function handleAppendUrl(
  store: SessionStore,
  input: AppendUrlInput,
): Promise<AppendUrlOutput> {
  const signed = await store.signStagingUpload(keyOf(input), input.chunkId);
  return {
    chunkId: input.chunkId,
    uploadUrl: signed.url,
    objectName: signed.objectName,
    expiresAt: signed.expiresAt,
  };
}

export async function handleCommit(
  store: SessionStore,
  input: CommitInput,
): Promise<CommitOutput> {
  const result = await store.appendChunkToCanonical(keyOf(input), input.chunkId, {
    replace: input.replace,
  });
  return { ok: true, totalBytes: result.totalBytes, componentCount: result.componentCount };
}

export async function handleAgentAppendUrl(
  store: SessionStore,
  input: AgentAppendUrlInput,
): Promise<AppendUrlOutput> {
  const signed = await store.signStagingUpload(agentKeyOf(input), input.chunkId);
  return {
    chunkId: input.chunkId,
    uploadUrl: signed.url,
    objectName: signed.objectName,
    expiresAt: signed.expiresAt,
  };
}

export async function handleAgentCommit(
  store: SessionStore,
  input: AgentCommitInput,
): Promise<CommitOutput> {
  const result = await store.appendChunkToCanonical(agentKeyOf(input), input.chunkId, {
    replace: input.replace,
  });
  return { ok: true, totalBytes: result.totalBytes, componentCount: result.componentCount };
}

export async function handleCanonicalDownload(
  store: SessionStore,
  input: CanonicalDownloadInput,
): Promise<CanonicalDownloadOutput> {
  const signed = await store.signCanonicalDownload(keyOf(input));
  return { url: signed.url, expiresAt: signed.expiresAt };
}

export async function handleArtifactRead(
  store: SessionStore,
  input: ArtifactReadInput,
): Promise<{ name: string; content: string | null }> {
  const content = await store.readArtifactText(keyOf(input), input.name);
  return { name: input.name, content };
}

export async function handleListSessionMetadata(
  store: SessionStore,
  input: ListSessionMetadataInput,
): Promise<{ sessions: SessionMetadata[] }> {
  // NB: the HTTP /sessions route is the self-hosted direct-connect client's
  // PRIMARY list (no PG-backed HTTP alternative — "no PG bookkeeping" above), so
  // it keeps serving the artifact title. The PG-authoritative title policy
  // (MC-2606) applies to the tunnel fallback in rpc.ts, where listSessions (PG)
  // is the primary and this store scan is only the degraded fallback.
  return { sessions: await store.listSessionMetadata(input.userId) };
}
