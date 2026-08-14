// §12 Step 2 — one-time migration of existing beta sessions from the workbench's
// old store into this fortress. For each not-yet-migrated session it: reconstructs
// the canonical transcript from the workbench turn index (raw_event, seq order) —
// or, if you pass a blob reader, from the old GCS canonical — writes the blob to
// the fortress S3, replays it through ingestCommit (new kind taxonomy + tool
// text), and lets the embed worker vectorize the new turns. Idempotent + resumable.
//
//   FORTRESS_DATABASE_URL=… WORKBENCH_DATABASE_URL=… FORTRESS_OPENAI_API_KEY=… \
//   FORTRESS_S3_BUCKET=… FORTRESS_S3_REGION=… (+ AWS creds) \
//   bun scripts/migrate-from-workbench.ts [--limit N] [--embed]
import { createHxDb } from "../src/host/postgres/db";
import { ingestCommit } from "../src/ingest/ingest";
import { S3Store } from "../src/modules/session-vault/store/s3-store";
import { createEmbedWorker, createOpenAIEmbedder } from "../src/modules/embed-worker";
import type { SessionStore } from "../src/modules/session-vault/store/types";

const FORTRESS_DSN = process.env.FORTRESS_DATABASE_URL!;
const WORKBENCH_DSN = process.env.WORKBENCH_DATABASE_URL!;
const LIMIT = Number(process.env.MIGRATE_LIMIT ?? process.argv.includes("--limit") ? process.argv[process.argv.indexOf("--limit") + 1] : 0) || 0;

function s3FromEnv(): SessionStore | null {
  const bucket = process.env.FORTRESS_S3_BUCKET, region = process.env.FORTRESS_S3_REGION;
  if (!bucket || !region) return null;
  return new S3Store({ region, bucketName: bucket, credentials: process.env.AWS_ACCESS_KEY_ID ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!, sessionToken: process.env.AWS_SESSION_TOKEN } : undefined });
}

/** Reconstruct a session's canonical JSONL from the workbench turn index. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function canonicalFromWorkbench(wb: any, sessionRowId: string): Promise<string> {
  const rows = await wb`SELECT raw_event FROM hx_session_turns WHERE session_row_id = ${sessionRowId} AND deleted_at IS NULL ORDER BY seq` as Array<{ raw_event: unknown }>;
  return rows.map((r) => (typeof r.raw_event === "string" ? r.raw_event : JSON.stringify(r.raw_event))).join("\n");
}

async function main() {
  // SAFETY GATE — this is the FALLBACK path (spec §12 Step 2). The PRIMARY fill
  // is the hx daemon auto-reupload (a freshly-joined vault re-uploads every local
  // session from zero). Run this ONLY for sessions with no live device to re-upload
  // them (decommissioned machines, pruned files). Toggle-gated, OFF by default, not
  // run on deploy: set HX_MIGRATE_FROM_WORKBENCH=1 (or pass --run) to enable.
  if (process.env.HX_MIGRATE_FROM_WORKBENCH !== "1" && !process.argv.includes("--run")) {
    console.log("[migrate] safety gate: fallback path is OFF. Primary fill = hx daemon auto-reupload. To run this fallback, set HX_MIGRATE_FROM_WORKBENCH=1 or pass --run.");
    process.exit(0);
  }
  const fortSql = new Bun.SQL(FORTRESS_DSN);
  const db = createHxDb(FORTRESS_DSN);
  const wb = new Bun.SQL(WORKBENCH_DSN, { max: 4 });
  const store = s3FromEnv();
  const embedder = process.env.FORTRESS_OPENAI_API_KEY ? createOpenAIEmbedder({ apiKey: process.env.FORTRESS_OPENAI_API_KEY, model: "text-embedding-3-large", dimensions: 1024 }) : null;

  const sessions = await wb`SELECT id, user_id, family, session_id FROM hx_sessions WHERE deleted_at IS NULL ${LIMIT ? wb`LIMIT ${LIMIT}` : wb``}` as Array<{ id: string; user_id: string; family: string; session_id: string }>;
  console.log(`workbench sessions to consider: ${sessions.length}`);

  let migrated = 0, skipped = 0, empty = 0;
  for (const s of sessions) {
    const key = { userId: s.user_id, family: s.family, sessionId: s.session_id };
    // idempotent: skip if the fortress already holds this identity's session.
    // Bound tagged-template params (never string-interpolated) so a session's
    // user_id/family/session_id can't inject SQL.
    const [exists] = await fortSql`SELECT count(*)::int AS n FROM hx.sessions ss JOIN hx.users u ON u.id=ss.user_id WHERE u.external_id=${s.user_id} AND ss.family=${s.family} AND ss.session_id=${s.session_id} AND ss.deleted_at IS NULL` as Array<{ n: number }>;
    if (exists.n > 0) { skipped++; continue; }
    const canonical = await canonicalFromWorkbench(wb, s.id);
    if (!canonical.trim()) { empty++; continue; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (store) { try { const signed = await store.signStagingUpload(key, "migrate"); await fetch(signed.url, { method: "PUT", body: canonical, headers: { "content-type": "application/x-ndjson" } }); await store.appendChunkToCanonical(key, "migrate", { replace: true }); } catch (e: any) { console.log(`  blob warn ${s.session_id}: ${e?.message?.slice(0, 50)}`); } }
    await ingestCommit(db, { attribution: { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null }, key, chunkId: "migrate", replace: false, chunkText: canonical, totalBytes: canonical.length, componentCount: 1, meta: { title: `migrated ${s.session_id.slice(0, 8)}` } });
    migrated++;
    if (migrated % 25 === 0) console.log(`  migrated ${migrated}…`);
  }
  console.log(`ingested: migrated=${migrated} skipped(already in fortress)=${skipped} empty(no turns)=${empty}`);

  if (embedder && (process.argv.includes("--embed") || process.env.MIGRATE_EMBED)) {
    const w = createEmbedWorker({ dsn: FORTRESS_DSN, embedder, maxPerPass: 500 });
    let total = 0; for (;;) { const r = await w.runOnce(); total += r.written; if (r.claimed === 0) break; } await w.stop();
    console.log(`embedded ${total} new turns`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("MIGRATION FAILED:", e?.message ?? e); process.exit(1); });
