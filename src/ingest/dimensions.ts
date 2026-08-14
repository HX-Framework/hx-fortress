// Identity reconciliation for the ingestion path. The capability token carries
// the cloud's external ids (org/repo/project/user/device); the bundled hx
// dimension tables key on those external ids, so each commit upserts the row
// and returns its local uuid for the session FKs. All run inside the commit
// transaction (HxTx).

import { and, eq } from "drizzle-orm";

import type { HxTx } from "../host/postgres/db";
import { hxDevices, hxModels, hxOrgs, hxProjects, hxRepos, hxUsers } from "../host/postgres/schema";
import { priceForModel } from "./pricing";

// READ FIRST — do not turn these back into bare ON CONFLICT DO UPDATE.
//
// `ON CONFLICT DO UPDATE` takes an EXCLUSIVE row lock on the conflicting row,
// on EVERY ingest, even when the SET is a no-op. These rows are SHARED — one per
// user / org / project / repo — and the lock is held until the transaction
// commits. So every concurrent ingest for the same user serialised behind
// whichever transaction held that row, for as long as that transaction ran: a
// guarantor restore replaying a large transcript blocked every live chunk from
// that user for its whole duration.
//
// That is the contention underneath the 2026-08-05 outage. Before v0.18.0 the
// waiters blocked up to statement_timeout (120 s) while holding a pooled
// connection, which is what exhausted the pool; v0.18.0 bounded the wait with
// lock_timeout, which stopped the connection hoarding but converted the same
// contention into 55P03 failures (~35% of commits, and every failure left a
// row-less canonical for the guarantor to repair).
//
// A plain SELECT takes no row lock. Reading first removes the contention
// entirely in the steady state, where the row already exists and nothing about
// it changes; the write path runs only on first sight of a dimension, or when a
// value genuinely differs. DO NOTHING + re-select settles the insert race.
//
// The `updatedAt` refresh these upserts used to perform on every commit is gone
// for user/org/project: nothing reads those columns (session rows carry the real
// recency in lastActivityAt), so it bought nothing and cost a lock every time.

/** Resolve a dimension row id: read, else insert-if-absent, else re-read (the
 *  concurrent-insert race). Never takes a row lock when the row already exists. */
async function readOrInsert(
  read: () => Promise<{ id: string } | undefined>,
  insert: () => Promise<{ id: string } | undefined>,
  what: string,
): Promise<string> {
  const found = await read();
  if (found) return found.id;
  const inserted = await insert();
  if (inserted) return inserted.id;
  // DO NOTHING returned no row: a concurrent transaction inserted it first.
  const raced = await read();
  if (raced) return raced.id;
  throw new Error(`dimension_resolve_failed:${what}`);
}

export async function upsertUser(tx: HxTx, externalId: string): Promise<string> {
  return readOrInsert(
    async () =>
      (
        await tx.select({ id: hxUsers.id }).from(hxUsers).where(eq(hxUsers.externalId, externalId)).limit(1)
      )[0],
    async () =>
      (
        await tx
          .insert(hxUsers)
          .values({ externalId })
          .onConflictDoNothing({ target: hxUsers.externalId })
          .returning({ id: hxUsers.id })
      )[0],
    "user",
  );
}

export async function upsertOrg(tx: HxTx, externalId: string): Promise<string> {
  return readOrInsert(
    async () =>
      (await tx.select({ id: hxOrgs.id }).from(hxOrgs).where(eq(hxOrgs.externalId, externalId)).limit(1))[0],
    async () =>
      (
        await tx
          .insert(hxOrgs)
          .values({ externalId })
          .onConflictDoNothing({ target: hxOrgs.externalId })
          .returning({ id: hxOrgs.id })
      )[0],
    "org",
  );
}

export async function upsertProject(
  tx: HxTx,
  orgId: string,
  externalId: string,
): Promise<string> {
  return readOrInsert(
    async () =>
      (
        await tx
          .select({ id: hxProjects.id })
          .from(hxProjects)
          .where(and(eq(hxProjects.orgId, orgId), eq(hxProjects.externalId, externalId)))
          .limit(1)
      )[0],
    async () =>
      (
        await tx
          .insert(hxProjects)
          .values({ orgId, externalId })
          .onConflictDoNothing({ target: [hxProjects.orgId, hxProjects.externalId] })
          .returning({ id: hxProjects.id })
      )[0],
    "project",
  );
}

export async function upsertRepo(
  tx: HxTx,
  slug: string,
  projectId: string | null,
  now: string,
): Promise<string> {
  const key = slug.toLowerCase();
  const existing = (
    await tx
      .select({ id: hxRepos.id, projectId: hxRepos.projectId })
      .from(hxRepos)
      .where(eq(hxRepos.slug, key))
      .limit(1)
  )[0];
  if (existing) {
    // Unlike the pure-identity dimensions, a repo carries a mutable association.
    // Take the write lock ONLY when it genuinely changes — and never let an
    // unattributed commit (projectId null) clear an association a previous
    // attributed one established.
    if (projectId !== null && existing.projectId !== projectId) {
      await tx
        .update(hxRepos)
        .set({ projectId, updatedAt: now })
        .where(eq(hxRepos.id, existing.id));
    }
    return existing.id;
  }
  return readOrInsert(
    async () =>
      (await tx.select({ id: hxRepos.id }).from(hxRepos).where(eq(hxRepos.slug, key)).limit(1))[0],
    async () =>
      (
        await tx
          .insert(hxRepos)
          .values({ slug: key, projectId })
          .onConflictDoNothing({ target: hxRepos.slug })
          .returning({ id: hxRepos.id })
      )[0],
    "repo",
  );
}

/** Upsert the device and stamp it as having just uploaded (genuine contact +
 *  data), per the spec: last_upload_at on every commit, last_seen_at on any
 *  authed contact. */
export async function upsertDevice(
  tx: HxTx,
  userId: string,
  deviceId: string,
  now: string,
): Promise<string> {
  const [row] = await tx
    .insert(hxDevices)
    .values({ userId, deviceId, lastUploadAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [hxDevices.userId, hxDevices.deviceId],
      set: { lastUploadAt: now, lastSeenAt: now, updatedAt: now },
    })
    .returning({ id: hxDevices.id });
  return row.id;
}

/** Upsert a model dimension, seeding the per-Mtok columns from the shared price
 *  map so the analysis layer can price tokens without re-deriving them. */
export async function upsertModel(tx: HxTx, modelId: string, now: string): Promise<string> {
  const price = priceForModel(modelId);
  const pricing = price
    ? {
        inputPerMtok: price.inputPerMtok,
        outputPerMtok: price.outputPerMtok,
        cacheReadPerMtok: price.cacheReadPerMtok,
        cacheWritePerMtok: price.cacheWritePerMtok,
      }
    : {};
  const existing = (
    await tx
      .select({ id: hxModels.id, inputPerMtok: hxModels.inputPerMtok })
      .from(hxModels)
      .where(eq(hxModels.modelId, modelId))
      .limit(1)
  )[0];
  if (existing) {
    // Prices change with a release, so they must still be refreshed — but only
    // when they actually differ, not on every commit.
    if (price && existing.inputPerMtok !== price.inputPerMtok) {
      await tx
        .update(hxModels)
        .set({ ...pricing, updatedAt: now })
        .where(eq(hxModels.id, existing.id));
    }
    return existing.id;
  }
  return readOrInsert(
    async () =>
      (await tx.select({ id: hxModels.id }).from(hxModels).where(eq(hxModels.modelId, modelId)).limit(1))[0],
    async () =>
      (
        await tx
          .insert(hxModels)
          .values({ modelId, ...pricing })
          .onConflictDoNothing({ target: hxModels.modelId })
          .returning({ id: hxModels.id })
      )[0],
    "model",
  );
}
