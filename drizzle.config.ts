import { defineConfig } from "drizzle-kit";

// Dev-time only, and only as a DIFF AID: point `drizzle-kit generate` at a
// scratch `out` to see what the schema changed, then hand-write the migration.
// The migration set is no longer a drizzle output — `out` holds no journal and
// no snapshots (nothing here is a source of truth for apply order; the registry
// in src/host/postgres/migrations/manifest.ts is), and running `generate`
// against this path would re-create both. At RUNTIME the `.sql` files are
// imported as embedded text and applied by src/host/postgres/migrate.ts —
// Drizzle's own fs-based migrator can't run inside the compiled binary, so the
// runtime never reads this config or the migrations folder from disk.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/host/postgres/schema/index.ts",
  out: "./src/host/postgres/migrations",
  schemaFilter: ["hx"],
});
