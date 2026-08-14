// Putting the corpus somewhere: as rows in a database, as objects in a bucket,
// and as files on disk for the harness that owns neither.
//
// The split is deliberate. The corpus module knows WHAT the world is; this one
// knows how to hand it to something. Rows go through a Drizzle handle the caller
// already holds, objects through a two-method writer any store or emulator can
// satisfy, and the on-disk materialization exists because the seed has no
// business minting bucket credentials of its own — the test rig already holds
// emulator credentials, and the operator already holds the real ones.
//
// Every write is an UPSERT on a natural key with a derived primary key, so
// seeding twice produces the same world rather than two of it.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import {
  hxDeletedSessions,
  hxDevices,
  hxModels,
  hxOrgs,
  hxProjects,
  hxRepos,
  hxSessions,
  hxUsers,
} from "../host/postgres/schema";
import { replaceRoster } from "../console/roster";
import { buildSeedCorpus, seedInventory, seedUuid, type SeedBucket, type SeedCorpus } from "./corpus";

/** The narrowest thing that can hold a seeded object. Any store, any emulator,
 *  any directory — the corpus does not care which. */
export interface SeedObjectWriter {
  put(bucket: SeedBucket, objectName: string, text: string): Promise<void>;
}

export interface SeedApplyResult {
  users: number;
  devices: number;
  sessions: number;
  tombstones: number;
  objects: number;
  /** Members written to hx.roster, through the SAME replace the tunnel uses —
   *  never a hand-written INSERT, so the seeded world is one a real sync could
   *  have produced. */
  rosterMembers: number;
}

/**
 * Write every dimension, session and tombstone.
 *
 * Ordered by dependency (orgs → projects → repos → users → devices → sessions)
 * because the columns are real foreign keys, not opaque ids: a session inserted
 * before its user is a constraint violation, not a dangling reference.
 */
export async function applySeedRows(db: HxDb, corpus: SeedCorpus = buildSeedCorpus()): Promise<SeedApplyResult> {
  const orgId = (externalId: string): string => seedUuid(`org/${externalId}`);
  const projectId = (externalId: string): string => seedUuid(`project/${externalId}`);
  const repoId = (slug: string): string => seedUuid(`repo/${slug}`);
  const userId = (externalId: string): string => seedUuid(`user/${externalId}`);
  const deviceId = (device: string): string => seedUuid(`device/${device}`);
  const modelRowId = (modelId: string): string => seedUuid(`model/${modelId}`);

  await db
    .insert(hxOrgs)
    .values(corpus.orgs.map((o) => ({ id: orgId(o.externalId), externalId: o.externalId, name: o.name })))
    .onConflictDoUpdate({ target: hxOrgs.externalId, set: { name: sql`excluded.name` } });

  await db
    .insert(hxProjects)
    .values(
      corpus.projects.map((p) => ({
        id: projectId(p.externalId),
        orgId: orgId(p.orgExternalId),
        externalId: p.externalId,
        name: p.name,
      })),
    )
    .onConflictDoUpdate({
      target: [hxProjects.orgId, hxProjects.externalId],
      set: { name: sql`excluded.name` },
    });

  await db
    .insert(hxRepos)
    .values(
      corpus.repos.map((r) => ({
        id: repoId(r.slug),
        slug: r.slug,
        projectId: r.projectExternalId ? projectId(r.projectExternalId) : null,
      })),
    )
    .onConflictDoUpdate({ target: hxRepos.slug, set: { projectId: sql`excluded.project_id` } });

  await db
    .insert(hxModels)
    .values(
      corpus.models.map((m) => ({
        id: modelRowId(m.modelId),
        modelId: m.modelId,
        provider: m.provider,
        displayName: m.displayName,
      })),
    )
    .onConflictDoUpdate({ target: hxModels.modelId, set: { displayName: sql`excluded.display_name` } });

  await db
    .insert(hxUsers)
    .values(
      corpus.users.map((u) => ({
        id: userId(u.externalId),
        externalId: u.externalId,
        displayName: u.displayName,
        email: u.email,
      })),
    )
    .onConflictDoUpdate({ target: hxUsers.externalId, set: { displayName: sql`excluded.display_name` } });

  const devices = corpus.users.flatMap((u) =>
    u.devices.map((d) => ({
      id: deviceId(d.deviceId),
      userId: userId(u.externalId),
      deviceId: d.deviceId,
      name: d.name,
      os: d.os,
      arch: d.arch,
      lastSeenAt: d.lastSeenAt,
      lastUploadAt: d.lastUploadAt,
      syncTotal: d.syncTotal,
      syncDone: d.syncDone,
      syncReportedAt: d.syncReportedAt,
    })),
  );
  if (devices.length > 0) {
    await db
      .insert(hxDevices)
      .values(devices)
      .onConflictDoUpdate({
        target: [hxDevices.userId, hxDevices.deviceId],
        set: { lastSeenAt: sql`excluded.last_seen_at`, lastUploadAt: sql`excluded.last_upload_at` },
      });
  }

  await db
    .insert(hxSessions)
    .values(
      corpus.sessions.map((s) => ({
        id: seedUuid(`session-row/${s.userExternalId}/${s.sessionId}`),
        userId: userId(s.userExternalId),
        deviceId: s.deviceId ? deviceId(s.deviceId) : null,
        orgId: s.orgExternalId ? orgId(s.orgExternalId) : null,
        projectId: s.projectExternalId ? projectId(s.projectExternalId) : null,
        repoId: s.repoSlug ? repoId(s.repoSlug) : null,
        modelId: s.modelId ? modelRowId(s.modelId) : null,
        family: s.family,
        sessionId: s.sessionId,
        title: s.title,
        titleSource: s.titleSource,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        ingestChannel: s.ingestChannel,
        eventCount: s.eventCount,
        userTextCount: s.userTextCount,
        assistantCount: s.assistantCount,
        toolCallCount: s.toolCallCount,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheCreationTokens: s.cacheCreationTokens,
        estCostUsd: s.estCostUsd,
        bytesUploaded: s.bytesUploaded,
        chunkCount: s.chunkCount,
        lastUserText: s.lastUserText,
        lastAssistantText: s.lastAssistantText,
        firstEventAt: s.firstEventAt,
        lastActivityAt: s.lastActivityAt,
        deletedAt: s.deletedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [hxSessions.userId, hxSessions.family, hxSessions.sessionId],
      set: { lastActivityAt: sql`excluded.last_activity_at`, title: sql`excluded.title` },
    });

  if (corpus.tombstones.length > 0) {
    await db.insert(hxDeletedSessions).values(corpus.tombstones).onConflictDoNothing();
  }

  const roster = await replaceRoster(db, corpus.roster);

  const inventory = seedInventory(corpus);
  return {
    users: inventory.users,
    devices: inventory.devices,
    sessions: inventory.sessions,
    tombstones: inventory.tombstones,
    objects: 0,
    rosterMembers: roster.received,
  };
}

/** Hand every seeded object to a writer, source bucket first. */
export async function applySeedObjects(
  corpus: SeedCorpus,
  writer: SeedObjectWriter,
): Promise<number> {
  let written = 0;
  for (const object of corpus.objects) {
    await writer.put(object.bucket, object.objectName, object.text);
    written += 1;
  }
  return written;
}

/** A writer that lands objects as files under `<dir>/<bucket>/<objectName>`.
 *  Object names are code-built (never caller-supplied), and the join is asserted
 *  to stay inside `dir` regardless. */
export function directoryObjectWriter(dir: string): SeedObjectWriter {
  return {
    async put(bucket, objectName, text) {
      const target = path.resolve(dir, bucket, objectName);
      const root = path.resolve(dir, bucket);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`refusing to write outside the seed directory: ${objectName}`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text);
    },
  };
}

export interface MaterializedSeed {
  dir: string;
  rosterFile: string;
  rowsFile: string;
  inventoryFile: string;
  objects: number;
}

/**
 * Write the whole corpus to disk: the objects per bucket, the rosterSync PAYLOAD
 * (the wire frame itself, for a harness that wants to replay it over a fake hub
 * rather than write rows — applySeedRows already applies it), the row manifest,
 * and the
 * inventory the acceptance reads.
 */
export async function materializeSeed(
  dir: string,
  corpus: SeedCorpus = buildSeedCorpus(),
): Promise<MaterializedSeed> {
  await mkdir(dir, { recursive: true });
  const objects = await applySeedObjects(corpus, directoryObjectWriter(path.join(dir, "objects")));
  const rosterFile = path.join(dir, "roster-sync.json");
  const rowsFile = path.join(dir, "rows.json");
  const inventoryFile = path.join(dir, "inventory.json");
  await writeFile(rosterFile, `${JSON.stringify(corpus.roster, null, 2)}\n`);
  await writeFile(
    rowsFile,
    `${JSON.stringify(
      {
        epoch: corpus.epoch,
        orgs: corpus.orgs,
        projects: corpus.projects,
        repos: corpus.repos,
        models: corpus.models,
        users: corpus.users,
        sessions: corpus.sessions,
        tombstones: corpus.tombstones,
        faults: corpus.faults,
        migration: corpus.migration,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(inventoryFile, `${JSON.stringify(seedInventory(corpus), null, 2)}\n`);
  return { dir, rosterFile, rowsFile, inventoryFile, objects };
}
