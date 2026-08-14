import { bigint, doublePrecision, index, integer, text, unique, uuid } from "drizzle-orm/pg-core";

import { createdAt, deletedAt, pk, ts, updatedAt } from "./columns";
import { hxSchema } from "./namespace";

// ── Identity dimensions ─────────────────────────────────────────────────────
// Real FK'd tables (not opaque text ids). `external_id` is the cloud-side id,
// carried as a natural UNIQUE key so fortress rows reconcile with the cloud.

export const hxUsers = hxSchema.table(
  "users",
  {
    id: pk(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [unique("hx_users_external_unique").on(t.externalId)],
);

export const hxOrgs = hxSchema.table(
  "orgs",
  {
    id: pk(),
    externalId: text("external_id").notNull(),
    name: text("name"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [unique("hx_orgs_external_unique").on(t.externalId)],
);

export const hxProjects = hxSchema.table(
  "projects",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => hxOrgs.id, { onDelete: "restrict" }),
    externalId: text("external_id").notNull(),
    name: text("name"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [unique("hx_projects_org_external_unique").on(t.orgId, t.externalId)],
);

export const hxRepos = hxSchema.table(
  "repos",
  {
    id: pk(),
    // owner/name, lowercased.
    slug: text("slug").notNull(),
    projectId: uuid("project_id").references(() => hxProjects.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("hx_repos_slug_unique").on(t.slug),
    // FK cover: an unindexed foreign key makes every cascading delete (here a
    // SET NULL) scan this whole table ONCE PER DELETED PARENT ROW. Declared
    // here as well as in the migration so drizzle-kit never generates a DROP.
    index("hx_repos_project_id_idx").on(t.projectId),
  ],
);

export const hxDevices = hxSchema.table(
  "devices",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    // Stable per-machine id reported by hx-client.
    deviceId: text("device_id").notNull(),
    name: text("name"),
    os: text("os"),
    arch: text("arch"),
    lastSeenAt: ts("last_seen_at"),
    lastUploadAt: ts("last_upload_at"),
    syncTotal: integer("sync_total"),
    syncDone: integer("sync_done"),
    syncTotalBytes: bigint("sync_total_bytes", { mode: "number" }),
    syncReportedAt: ts("sync_reported_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [unique("hx_devices_user_device_unique").on(t.userId, t.deviceId)],
);

export const hxModels = hxSchema.table(
  "models",
  {
    id: pk(),
    // e.g. "claude-opus-4-8".
    modelId: text("model_id").notNull(),
    provider: text("provider"),
    displayName: text("display_name"),
    inputPerMtok: doublePrecision("input_per_mtok"),
    outputPerMtok: doublePrecision("output_per_mtok"),
    cacheReadPerMtok: doublePrecision("cache_read_per_mtok"),
    cacheWritePerMtok: doublePrecision("cache_write_per_mtok"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [unique("hx_models_model_id_unique").on(t.modelId)],
);

export type HxUser = typeof hxUsers.$inferSelect;
export type HxOrg = typeof hxOrgs.$inferSelect;
export type HxProject = typeof hxProjects.$inferSelect;
export type HxRepo = typeof hxRepos.$inferSelect;
export type HxDevice = typeof hxDevices.$inferSelect;
export type HxModel = typeof hxModels.$inferSelect;
