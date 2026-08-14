// The cluster's role/database/schema names, in their own module so the console
// plane and the cluster provisioner can both import them without a cycle.

export const PG_ROLE = "fortress";
export const PG_DATABASE = "hx-db";
export const PG_SCHEMA = "hx";
/** SELECT-only login role for the MCP read tools — inherits the NOLOGIN
 *  `hx_readonly` role's grants (migration 0005). */
export const PG_APP_RO_ROLE = "hx_app_ro";
/** DML (no-DDL, no-superuser) login role for ingest + the embed worker. */
export const PG_APP_RW_ROLE = "hx_app_rw";
/** The NOLOGIN role migration 0005 grants schema-wide SELECT to; `hx_app_ro`
 *  is a member so its SELECT set tracks the read grants centrally. */
export const PG_READONLY_ROLE = "hx_readonly";
