// One table's structure, as the table itself says it: its columns (PRAGMA table_info), its indexes
// (index_list and index_info), its foreign keys (foreign_key_list), the statements that make it
// again (`sqlite_master`), what made it (`_tables`), and for a managed table the migrations whose
// SQL names it (`_migrations`). The Data view's reader answers the same shape for a running app's
// SQLite from the same PRAGMAs.
//
// Only the PRAGMA statements: the host's guard refuses the `pragma_*()` table functions other than
// `pragma_table_info`, and `table_xinfo` on the platform's own tables. The store's own tables and a
// program's are read as a managed table is; a parked table has no structure to read until it is
// back, since its rows and its table wait in the store's files.

import { StoreError, type StoreCore } from "./core.js";
import { retypeViewColumns, StoreDataError } from "./data.js";
import { parkedWords } from "./park-time.js";
import { isHiddenTable, namesIn, PROGRAM_VERSION_RE, SYSTEM_TABLES, type StoreSqlValue } from "./sql.js";
import { DATABASE, type ForeignKeyAction, type Structure, type StructureBody, type StructureColumn, type StructureForeignKey, type StructureIndex, type StructureMigration } from "./types.js";

/** The longest SQL one statement group carries: the table's own, or one migration's. The wire contract says the same. */
export const STRUCTURE_SQL_MAX = 20_000;
/** The most migrations a structure lists: the newest that name the table. */
export const STRUCTURE_MIGRATIONS_MAX = 50;

// Backticks, never double quotes (sql.ts): a name SQLite cannot find is then an error, not text.
const ident = (name: string) => `\`${name.replace(/`/g, "``")}\``;
const SYSTEM = new Set<string>(SYSTEM_TABLES);

const ACTIONS: Record<string, ForeignKeyAction> = {
  "NO ACTION": "no action",
  RESTRICT: "restrict",
  CASCADE: "cascade",
  "SET NULL": "set null",
  "SET DEFAULT": "set default",
};

/** What a foreign key does, in the contract's words; SQLite answers "NO ACTION" for none said. */
export function foreignKeyAction(said: unknown): ForeignKeyAction {
  return ACTIONS[String(said ?? "").toUpperCase()] ?? "no action";
}

/** SQL cut at the most a structure carries, and whether it was. */
function bounded(text: string): { text: string; cut: boolean } {
  return text.length > STRUCTURE_SQL_MAX ? { text: text.slice(0, STRUCTURE_SQL_MAX), cut: true } : { text, cut: false };
}

/**
 * SQL text with every quoted name, string and comment blanked out at the same length, so a
 * parenthesis, a comma or a keyword found in it stands where the original's does.
 */
export function maskedSql(text: string): string {
  return text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => {
    if (m.startsWith("--") || m.startsWith("/*")) return " ".repeat(m.length);
    return m.length < 2 ? m : m[0] + "_".repeat(m.length - 2) + m[m.length - 1];
  });
}

/**
 * An index's terms and its condition, from its CREATE INDEX: `CREATE INDEX i ON t (lower(name),
 * id) WHERE done = 0` reads as ["lower(name)", "id"] and "done = 0". SQLite's index_info names a
 * column but not an expression, which only the statement holds.
 */
export function indexParts(createSql: string | null): { terms: string[]; where: string | null } {
  if (!createSql) return { terms: [], where: null };
  const mask = maskedSql(createSql);
  const on = /\bON\b/i.exec(mask);
  const open = on ? mask.indexOf("(", on.index) : -1;
  if (open < 0) return { terms: [], where: null };
  const terms: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === "(") depth += 1;
    else if (ch === "," && depth === 1) {
      terms.push(createSql.slice(start, i).trim());
      start = i + 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth > 0) continue;
      terms.push(createSql.slice(start, i).trim());
      const where = /^\s*WHERE\b/i.exec(mask.slice(i + 1));
      const condition = where ? createSql.slice(i + 1 + where[0].length).trim().replace(/;\s*$/, "").trim() : "";
      return { terms: terms.filter(Boolean), where: condition || null };
    }
  }
  return { terms: [], where: null };
}

/** The statements that make the table again, each ending in a semicolon: its own, then its indexes', then its triggers'. */
function statementsOf(own: string | null, others: readonly (string | null)[]): string {
  return [own, ...others]
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .map((text) => (/;\s*$/.test(text) ? text.trim() : `${text.trim()};`))
    .join("\n\n");
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** The table a request names, as `sqlite_master` holds it: refused when it is hidden, an old version, or parked. */
function tableOf(core: StoreCore, body: StructureBody): MasterRow {
  if (body.database !== DATABASE) throw new StoreDataError(404, `A store has one database, "${DATABASE}".`);
  const sql = core.sql;
  const found = sql
    .exec<Record<string, StoreSqlValue>>("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?", body.table)
    .toArray()
    .map((r) => ({ type: String(r.type), name: String(r.name), tbl_name: String(r.tbl_name), sql: r.sql === null || r.sql === undefined ? null : String(r.sql) }))[0];
  if (found && !isHiddenTable(found.name) && !PROGRAM_VERSION_RE.test(found.name)) return found;
  if (sql.exec("SELECT 1 FROM _tables WHERE name = ? AND kind = 'program' AND parked IS NOT NULL", body.table).toArray().length > 0) {
    throw new StoreError(409, "table_parked", parkedWords(body.table));
  }
  throw new StoreDataError(404, `This store has no table "${body.table}".`);
}

export function structure(core: StoreCore, body: StructureBody): Structure {
  const started = core.deps.now();
  const sql = core.sql;
  const table = tableOf(core, body);
  const view = table.type === "view";

  const info = sql.exec<Record<string, StoreSqlValue>>(`PRAGMA table_info(${ident(table.name)})`).toArray();
  const read = info.map((c) => ({
    cid: Number(c.cid),
    name: String(c.name),
    type: String(c.type ?? ""),
    notnull: Number(c.notnull),
    pk: Number(c.pk),
    dflt: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
  }));
  // A view's column whose source has no declared type reads as text, as the grid's head shows it.
  if (view) retypeViewColumns(sql, table.name, read);
  const key = read.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);

  // The statements beside the table's own: its indexes' and its triggers', by name.
  const beside = sql
    .exec<Record<string, StoreSqlValue>>("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') ORDER BY type, name", table.name)
    .toArray()
    .map((r) => ({ type: String(r.type), name: String(r.name), sql: r.sql === null || r.sql === undefined ? null : String(r.sql) }));
  const indexSql = new Map(beside.filter((r) => r.type === "index").map((r) => [r.name, r.sql]));

  const indexes: StructureIndex[] = [];
  const unique = new Set<string>();
  if (!view) {
    for (const row of sql.exec<Record<string, StoreSqlValue>>(`PRAGMA index_list(${ident(table.name)})`).toArray()) {
      const name = String(row.name);
      const statement = indexSql.get(name) ?? null;
      const parts = indexParts(statement);
      const columns = sql
        .exec<Record<string, StoreSqlValue>>(`PRAGMA index_info(${ident(name)})`)
        .toArray()
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((c, i) => (c.name === null || c.name === undefined ? (parts.terms[i] ?? "rowid") : String(c.name)));
      const origin = String(row.origin) === "pk" ? "key" : String(row.origin) === "u" ? "unique" : "index";
      const isUnique = Number(row.unique) === 1;
      const partial = Number(row.partial) === 1;
      if (isUnique && !partial && origin !== "key" && columns.length === 1) unique.add(columns[0]!);
      indexes.push({
        name,
        columns,
        unique: isUnique,
        origin,
        ...(partial && parts.where ? { where: parts.where } : {}),
        ...(statement ? { sql: statement } : {}),
      });
    }
    const rank = { key: 0, unique: 1, index: 2 } as const;
    indexes.sort((a, b) => rank[a.origin] - rank[b.origin] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  const columns: StructureColumn[] = read.map((c) => ({
    name: c.name,
    type: c.type,
    nullable: c.notnull === 0 && c.pk === 0,
    default: c.dflt,
    ...(c.pk > 0 ? { key: c.pk } : {}),
    ...(unique.has(c.name) ? { unique: true } : {}),
  }));

  // A table a foreign key names is read in any letter case; the catalog names it as SQLite keeps it.
  const byLower = new Map(
    sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
      .toArray()
      .map((r) => [String(r.name).toLowerCase(), String(r.name)]),
  );
  const foreignKeys: StructureForeignKey[] = [];
  if (!view) {
    const byId = new Map<number, Record<string, StoreSqlValue>[]>();
    for (const row of sql.exec<Record<string, StoreSqlValue>>(`PRAGMA foreign_key_list(${ident(table.name)})`).toArray()) {
      const id = Number(row.id);
      byId.set(id, [...(byId.get(id) ?? []), row]);
    }
    for (const [, parts] of [...byId.entries()].sort((a, b) => a[0] - b[0])) {
      const ordered = parts.sort((a, b) => Number(a.seq) - Number(b.seq));
      const first = ordered[0]!;
      const target = String(first.table);
      foreignKeys.push({
        columns: ordered.map((p) => String(p.from)),
        table: byLower.get(target.toLowerCase()) ?? target,
        to: ordered.every((p) => p.to !== null && p.to !== undefined) ? ordered.map((p) => String(p.to)) : [],
        onUpdate: foreignKeyAction(first.on_update),
        onDelete: foreignKeyAction(first.on_delete),
      });
    }
  }

  const statements = bounded(statementsOf(table.sql, beside.map((r) => r.sql)));

  // What made it: a program's job, a migration or exec, or the store itself.
  const meta = sql
    .exec<Record<string, StoreSqlValue>>("SELECT kind, version, made_run, made_step, made_job, made_at FROM _tables WHERE name = ?", table.name)
    .toArray()[0];
  const kind: Structure["kind"] = SYSTEM.has(table.name) ? "system" : meta?.kind === "program" ? "program" : "managed";
  const madeBy =
    meta?.made_at !== null && meta?.made_at !== undefined
      ? {
          runId: meta.made_run === null || meta.made_run === undefined ? null : String(meta.made_run),
          step: meta.made_step === null || meta.made_step === undefined ? null : String(meta.made_step),
          job: meta.made_job === null || meta.made_job === undefined ? null : String(meta.made_job),
          at: String(meta.made_at),
        }
      : null;

  return {
    database: DATABASE,
    table: table.name,
    ...(view ? { view: true } : {}),
    columns,
    key,
    indexes,
    foreignKeys,
    sql: statements.text,
    ...(statements.cut ? { sqlCut: true } : {}),
    ...(kind === "managed" ? { migrations: migrationsNaming(core, table.name) } : {}),
    ms: core.deps.now() - started,
    kind,
    version: meta ? Number(meta.version) : 1,
    madeBy,
  };
}

/** The store's migrations whose SQL names the table, oldest first: the newest STRUCTURE_MIGRATIONS_MAX. */
function migrationsNaming(core: StoreCore, table: string): StructureMigration[] {
  const lower = table.toLowerCase();
  const naming = core.sql
    .exec<Record<string, StoreSqlValue>>("SELECT id, sql, applied_at, applied_by FROM _migrations ORDER BY applied_at, id")
    .toArray()
    .filter((row) => namesIn(String(row.sql)).has(lower));
  return naming.slice(-STRUCTURE_MIGRATIONS_MAX).map((row) => {
    const text = bounded(String(row.sql));
    return {
      id: String(row.id),
      appliedAt: String(row.applied_at),
      appliedBy: String(row.applied_by),
      sql: text.text,
      ...(text.cut ? { cut: true } : {}),
    };
  });
}
