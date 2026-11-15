package engine

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/secure"
)

// Postgres speaks to PostgreSQL with pgx.
type Postgres struct{}

// Open connects with pgx. Every field is set here, so no PG* variable of the machine changes
// where it connects or as whom.
func (Postgres) Open(ctx context.Context, spec Spec) (*sql.DB, error) {
	j := spec.Job
	cfg, err := pgx.ParseConfig("sslmode=disable")
	if err != nil {
		return nil, err
	}
	cfg.Host = j.Server.Host
	cfg.Port = uint16(j.Server.Port)
	cfg.Database = j.Database
	cfg.User = j.Login.User
	cfg.Password = j.Login.Password
	cfg.ConnectTimeout = ConnectTimeout
	cfg.RuntimeParams = map[string]string{"application_name": spec.appName()}
	cfg.Fallbacks = nil
	cfg.KerberosSrvName, cfg.KerberosSpn = "", ""
	// The server's name stays a name: the job's Dialer decides where it goes.
	cfg.LookupFunc = func(_ context.Context, host string) ([]string, error) { return []string{host}, nil }
	cfg.DialFunc = spec.Dialer.DialContext
	tlsConfig, err := secure.Config(j, spec.Capture)
	if err != nil {
		return nil, err
	}
	cfg.TLSConfig = tlsConfig
	return newPool(ctx, stdlib.OpenDB(*cfg))
}

// Version is "PostgreSQL 16.4 (Ubuntu 16.4-1)".
func (Postgres) Version(ctx context.Context, q Querier) (string, error) {
	var v string
	err := q.QueryRowContext(ctx, `SELECT 'PostgreSQL ' || current_setting('server_version') /* version */`).Scan(&v)
	return firstLine(v), err
}

// The schemas a catalog leaves out: Postgres's own.
const pgOwnSchemas = `n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\_%'`

// Writes reads every table the login may INSERT, UPDATE, DELETE or TRUNCATE, and the powers that
// let it write beyond them. A grant on some of a table's columns counts (has_any_column_privilege
// also holds for the table's own grant); a partition counts as its parent, as in the catalog; and
// a table in a schema the login may not use counts not at all, since every write to it is refused.
func (Postgres) Writes(ctx context.Context, q Querier, _ string) (WriteSet, error) {
	ws := WriteSet{Tables: map[string]bool{}, Powers: []string{}}
	rows, err := q.QueryContext(ctx, `SELECT n.nspname, c.relname
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'f') AND NOT c.relispartition AND `+pgOwnSchemas+`
  AND has_schema_privilege(n.oid, 'USAGE')
  AND (has_any_column_privilege(c.oid, 'INSERT') OR has_any_column_privilege(c.oid, 'UPDATE')
    OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
/* writes:tables */`)
	if err != nil {
		return ws, err
	}
	defer rows.Close()
	for rows.Next() {
		var schema, name string
		if err := rows.Scan(&schema, &name); err != nil {
			return ws, err
		}
		ws.Tables[tableKey(schema, name)] = true
	}
	if err := rows.Err(); err != nil {
		return ws, err
	}

	var super, createRole, createDB, dbCreate, writeAll bool
	var schemas string
	err = q.QueryRowContext(ctx, `SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb,
  has_database_privilege(current_database(), 'CREATE'),
  CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pg_write_all_data')
    THEN pg_has_role(current_user, (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'pg_write_all_data'), 'USAGE')
    ELSE false END,
  COALESCE((SELECT string_agg(n.nspname, ', ' ORDER BY n.nspname) FROM pg_catalog.pg_namespace n
    WHERE has_schema_privilege(n.oid, 'CREATE') AND `+pgOwnSchemas+`), '')
FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
/* writes:powers */`).Scan(&super, &createRole, &createDB, &dbCreate, &writeAll, &schemas)
	if err != nil {
		return ws, err
	}
	if super {
		ws.Powers = append(ws.Powers, "superuser")
	}
	if writeAll {
		ws.Powers = append(ws.Powers, "pg_write_all_data")
	}
	if createRole {
		ws.Powers = append(ws.Powers, "CREATEROLE")
	}
	if createDB {
		ws.Powers = append(ws.Powers, "CREATEDB")
	}
	if dbCreate {
		ws.Powers = append(ws.Powers, "CREATE on the database")
	}
	if schemas != "" {
		ws.Powers = append(ws.Powers, "CREATE in schema "+schemas)
	}
	return ws, nil
}

// pgTables is the catalog's tables: what the login may read, outside Postgres's own schemas,
// partitions folded into their parent, first by schema and name.
const pgTables = `SELECT c.oid, n.nspname, c.relname,
  CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS kind,
  CASE
    WHEN c.relkind = 'p' THEN (SELECT sum(GREATEST(ch.reltuples, 0))::bigint FROM pg_catalog.pg_inherits i
      JOIN pg_catalog.pg_class ch ON ch.oid = i.inhrelid WHERE i.inhparent = c.oid)
    WHEN c.relkind IN ('r', 'm') AND c.reltuples >= 0 THEN c.reltuples::bigint
  END AS rows
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition AND ` + pgOwnSchemas + `
  AND has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')
ORDER BY n.nspname, c.relname
LIMIT $1`

// Catalog reads the tables, then their columns and primary keys in one more query.
func (Postgres) Catalog(ctx context.Context, q Querier, database string, max int, writes WriteSet) (job.Catalog, error) {
	b := newCatalogBuilder()
	rows, err := q.QueryContext(ctx, pgTables+"\n/* catalog:tables */", max+1)
	if err != nil {
		return job.Catalog{}, err
	}
	count := 0
	truncated := false
	for rows.Next() {
		var oid uint32
		var schema, name, kind string
		var estimate sql.NullInt64
		if err := rows.Scan(&oid, &schema, &name, &kind, &estimate); err != nil {
			rows.Close()
			return job.Catalog{}, err
		}
		count++
		if count > max {
			truncated = true
			break
		}
		b.addTable(job.Table{Schema: schema, Name: name, Kind: kind, Rows: rowsOrNil(estimate)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return job.Catalog{}, err
	}

	// indkey is an int2vector, whose subscripts start at 0: a column's place in the key, from 1,
	// is its subscript less the lower bound, plus one.
	cols, err := q.QueryContext(ctx, `WITH t AS (`+pgTables+`)
SELECT t.nspname, t.relname, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
  COALESCE(array_position(pk.indkey::int2[], a.attnum) - array_lower(pk.indkey::int2[], 1) + 1, 0)
FROM t JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
LEFT JOIN pg_catalog.pg_index pk ON pk.indrelid = t.oid AND pk.indisprimary
WHERE a.attnum > 0 AND NOT a.attisdropped
ORDER BY t.nspname, t.relname, a.attnum
/* catalog:columns */`, max)
	if err != nil {
		return job.Catalog{}, err
	}
	defer cols.Close()
	for cols.Next() {
		var schema, table, column, typ string
		var nullable bool
		var key int
		if err := cols.Scan(&schema, &table, &column, &typ, &nullable, &key); err != nil {
			return job.Catalog{}, err
		}
		b.addColumn(schema, table, job.Column{Name: column, Type: typ, Nullable: nullable, Key: key})
	}
	if err := cols.Err(); err != nil {
		return job.Catalog{}, err
	}
	return b.catalog("postgres", database, truncated, writes), nil
}

// Encryption is what the TLS handshake negotiated.
func (Postgres) Encryption(_ context.Context, _ Querier, spec Spec) job.Encryption {
	return spec.Capture.Encryption()
}

// Classify names Postgres's own errors by their SQLSTATE.
func (Postgres) Classify(err error) (string, string, bool) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch {
		case pgErr.Code == "28P01" || pgErr.Code == "28000":
			return "login", "The database refused the login: " + pgErr.Message, true
		case pgErr.Code == "3D000":
			return "database", "The server has no database of that name: " + pgErr.Message, true
		default:
			return "database", "The database answered: " + pgErr.Message + " (" + pgErr.Code + ")", true
		}
	}
	if strings.Contains(err.Error(), "server refused TLS connection") {
		return "tls", "The server does not accept TLS. Choose TLS off for this connection only if the server cannot speak it.", true
	}
	return "", "", false
}
