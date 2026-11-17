package engine

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	mssql "github.com/microsoft/go-mssqldb"
	"github.com/microsoft/go-mssqldb/msdsn"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/secure"
)

// SQLServer speaks to SQL Server and Azure SQL with Microsoft's own driver, go-mssqldb.
type SQLServer struct{}

// msConfig is the driver's config for a job: TDS 7 TLS for `verify` and `require`, TDS 8 for
// `strict`, and for `off` the driver's own default of encrypting only the login packet.
//
// No "connection timeout": go-mssqldb applies it to every read of the session, not just the login,
// so a query waiting longer for its next packet would fail. The login is bounded by the job's
// Dialer (LoginFor), and every query by its context.
func msConfig(spec Spec) (msdsn.Config, error) {
	j, capture := spec.Job, spec.Capture
	q := url.Values{}
	q.Set("database", j.Database)
	q.Set("app name", spec.appName())
	q.Set("dial timeout", "15")
	switch j.TLS.Mode {
	case "strict":
		q.Set("encrypt", "strict")
	case "off":
		q.Set("encrypt", "false")
	default:
		q.Set("encrypt", "true")
	}
	u := &url.URL{
		Scheme:   "sqlserver",
		User:     url.UserPassword(j.Login.User, j.Login.Password),
		Host:     net.JoinHostPort(j.Server.Host, strconv.Itoa(j.Server.Port)),
		RawQuery: q.Encode(),
	}
	cfg, err := msdsn.Parse(u.String())
	if err != nil {
		return msdsn.Config{}, fmt.Errorf("the SQL Server settings are not valid: %w", err)
	}
	tlsConfig, err := secure.Config(j, capture)
	if err != nil {
		return msdsn.Config{}, err
	}
	if tlsConfig == nil {
		// `off`: the login packet is still encrypted, the way SQL Server always asks, with a
		// certificate nobody checks; everything after it goes in the clear, unless the server
		// forces encryption (Encryption asks the server which it was).
		tlsConfig, err = secure.Config(job.Job{TLS: job.TLS{Mode: "require", MinVersion: "1.0"}, Server: j.Server}, capture)
		if err != nil {
			return msdsn.Config{}, err
		}
	}
	cfg.TLSConfig = tlsConfig
	// The certificate is checked against the server's own name, never the address the Dialer dials.
	cfg.HostInCertificateProvided = true
	cfg.Protocols = []string{"tcp"}
	return cfg, nil
}

// Open connects with go-mssqldb through the job's Dialer, which also refuses a login the server
// tries to route to another host (Azure SQL's Redirect policy).
func (SQLServer) Open(ctx context.Context, spec Spec) (*sql.DB, error) {
	cfg, err := msConfig(spec)
	if err != nil {
		return nil, err
	}
	connector := mssql.NewConnectorConfig(cfg)
	connector.Dialer = spec.Dialer
	return newPool(ctx, connector, spec.Dialer)
}

// Version is @@VERSION's first line: "Microsoft SQL Server 2022 (RTM-CU15) (KB5041321) - 16.0.4145.4 (X64)".
func (SQLServer) Version(ctx context.Context, q Querier) (string, error) {
	var v string
	err := q.QueryRowContext(ctx, `SELECT @@VERSION /* version */`).Scan(&v)
	return firstLine(v), err
}

// msObjectName is an object's two-part name, quoted, for HAS_PERMS_BY_NAME.
const msObjectName = `QUOTENAME(s.name) + N'.' + QUOTENAME(o.name)`

// Writes reads every table and view the login may INSERT, UPDATE or DELETE, those it may UPDATE
// some columns of (HAS_PERMS_BY_NAME on the object does not see a column's grant), and the roles
// and database permissions that let it write beyond them.
func (SQLServer) Writes(ctx context.Context, q Querier, _ string) (WriteSet, error) {
	ws := WriteSet{Tables: map[string]bool{}, Powers: []string{}}
	rows, err := q.QueryContext(ctx, `SELECT s.name, o.name
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
  AND (HAS_PERMS_BY_NAME(`+msObjectName+`, 'OBJECT', 'INSERT') = 1
    OR HAS_PERMS_BY_NAME(`+msObjectName+`, 'OBJECT', 'UPDATE') = 1
    OR HAS_PERMS_BY_NAME(`+msObjectName+`, 'OBJECT', 'DELETE') = 1)
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
	// Column grants to the login or a role it is in; a DENY elsewhere is not weighed, so a table
	// may read as writable that is not, never the other way.
	cols, err := q.QueryContext(ctx, `SELECT DISTINCT s.name, o.name
FROM sys.database_permissions p
JOIN sys.objects o ON o.object_id = p.major_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE p.class = 1 AND p.minor_id > 0 AND p.state IN ('G', 'W') AND p.permission_name IN ('INSERT', 'UPDATE')
  AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
  AND p.grantee_principal_id IN (SELECT principal_id FROM sys.user_token)
/* writes:columns */`)
	if err != nil {
		return ws, err
	}
	defer cols.Close()
	for cols.Next() {
		var schema, name string
		if err := cols.Scan(&schema, &name); err != nil {
			return ws, err
		}
		ws.Tables[tableKey(schema, name)] = true
	}
	if err := cols.Err(); err != nil {
		return ws, err
	}

	var sysadmin, owner, writer, ddl, create, alterSchema sql.NullInt64
	err = q.QueryRowContext(ctx, `SELECT IS_SRVROLEMEMBER('sysadmin'), IS_ROLEMEMBER('db_owner'),
  IS_ROLEMEMBER('db_datawriter'), IS_ROLEMEMBER('db_ddladmin'),
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE'),
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER ANY SCHEMA')
/* writes:powers */`).Scan(&sysadmin, &owner, &writer, &ddl, &create, &alterSchema)
	if err != nil {
		return ws, err
	}
	for _, p := range []struct {
		on   sql.NullInt64
		name string
	}{
		{sysadmin, "sysadmin"}, {owner, "db_owner"}, {writer, "db_datawriter"}, {ddl, "db_ddladmin"},
		{create, "CREATE TABLE"}, {alterSchema, "ALTER ANY SCHEMA"},
	} {
		if p.on.Valid && p.on.Int64 == 1 {
			ws.Powers = append(ws.Powers, p.name)
		}
	}
	return ws, nil
}

// msTables is the catalog's tables and views: what the login may read, first by schema and name.
// Row estimates come from the partitions of the heap or clustered index.
const msTables = `SELECT TOP (@p1) o.object_id, s.name AS schema_name, o.name AS object_name,
  CASE o.type WHEN 'V' THEN 'view' ELSE 'table' END AS kind,
  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS est
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
  AND HAS_PERMS_BY_NAME(` + msObjectName + `, 'OBJECT', 'SELECT') = 1
ORDER BY s.name, o.name`

// msColumnsBatch is how many tables one columns query names: SQL Server takes at most 2,100
// parameters in a statement.
const msColumnsBatch = 1000

// Catalog reads the tables, then their columns and primary keys, by the tables' ids, in as few
// queries as the parameter limit allows.
func (SQLServer) Catalog(ctx context.Context, q Querier, database string, max int, writes WriteSet) (job.Catalog, error) {
	b := newCatalogBuilder()
	rows, err := q.QueryContext(ctx, msTables+"\n/* catalog:tables */", max+1)
	if err != nil {
		return job.Catalog{}, err
	}
	count, truncated := 0, false
	ids := []any{}
	for rows.Next() {
		var id int64
		var schema, name, kind string
		var estimate sql.NullInt64
		if err := rows.Scan(&id, &schema, &name, &kind, &estimate); err != nil {
			rows.Close()
			return job.Catalog{}, err
		}
		count++
		if count > max {
			truncated = true
			break
		}
		ids = append(ids, id)
		b.addTable(job.Table{Schema: schema, Name: name, Kind: kind, Rows: rowsOrNil(estimate)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return job.Catalog{}, err
	}
	for start := 0; start < len(ids); start += msColumnsBatch {
		batch := ids[start:min(start+msColumnsBatch, len(ids))]
		if err := msColumns(ctx, q, b, batch); err != nil {
			return job.Catalog{}, err
		}
	}
	return b.catalog("sqlserver", database, truncated, writes), nil
}

// msColumns reads the columns and primary keys of the tables of ids. A type the login may not see
// (an alias or CLR type it has no permission on) reads as its base type, else as "unknown".
func msColumns(ctx context.Context, q Querier, b *catalogBuilder, ids []any) error {
	marks := make([]string, len(ids))
	for i := range ids {
		marks[i] = "@p" + strconv.Itoa(i+1)
	}
	cols, err := q.QueryContext(ctx, `SELECT s.name, o.name, c.name,
  COALESCE(TYPE_NAME(c.user_type_id), TYPE_NAME(c.system_type_id), N'unknown'), c.max_length, c.precision, c.scale,
  c.is_nullable, COALESCE(ic.key_ordinal, 0)
FROM sys.columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.indexes i ON i.object_id = c.object_id AND i.is_primary_key = 1
LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.column_id = c.column_id
WHERE c.object_id IN (`+strings.Join(marks, ", ")+`)
ORDER BY s.name, o.name, c.column_id
/* catalog:columns */`, ids...)
	if err != nil {
		return err
	}
	defer cols.Close()
	for cols.Next() {
		var schema, table, column string
		var typ sql.NullString
		var maxLength, precision, scale int64
		var nullable bool
		var key int
		if err := cols.Scan(&schema, &table, &column, &typ, &maxLength, &precision, &scale, &nullable, &key); err != nil {
			return err
		}
		name := "unknown"
		if typ.Valid {
			name = typ.String
		}
		b.addColumn(schema, table, job.Column{Name: column, Type: msType(name, maxLength, precision, scale), Nullable: nullable, Key: key})
	}
	return cols.Err()
}

// msType writes a column's type the way SQL Server's own tools do: "nvarchar(50)", "varchar(max)",
// "decimal(10,2)", "datetime2(7)". max_length is in bytes, so the N types halve it.
func msType(name string, maxLength, precision, scale int64) string {
	switch strings.ToLower(name) {
	case "varchar", "char", "varbinary", "binary":
		if maxLength == -1 {
			return name + "(max)"
		}
		return fmt.Sprintf("%s(%d)", name, maxLength)
	case "nvarchar", "nchar":
		if maxLength == -1 {
			return name + "(max)"
		}
		return fmt.Sprintf("%s(%d)", name, maxLength/2)
	case "decimal", "numeric":
		return fmt.Sprintf("%s(%d,%d)", name, precision, scale)
	case "datetime2", "datetimeoffset", "time":
		return fmt.Sprintf("%s(%d)", name, scale)
	}
	return name
}

// Encryption is what the TLS handshake negotiated. With `off` the login alone was encrypted,
// unless the server forces encryption on every connection (Azure SQL, Force Encryption): the
// server says which.
func (SQLServer) Encryption(ctx context.Context, q Querier, spec Spec) job.Encryption {
	if spec.Job.TLS.Mode != "off" {
		return spec.Capture.Encryption()
	}
	var option sql.NullString
	if err := q.QueryRowContext(ctx, `SELECT CONVERT(nvarchar(10), CONNECTIONPROPERTY('encrypt_option')) /* encryption */`).Scan(&option); err != nil ||
		!strings.EqualFold(option.String, "TRUE") {
		return job.Encryption{Kind: "none"}
	}
	return spec.Capture.Encryption()
}

// Classify names SQL Server's own errors by their number.
func (SQLServer) Classify(err error) (string, string, bool) {
	var msErr mssql.Error
	if errors.As(err, &msErr) {
		switch msErr.Number {
		case 18456, 18452, 18486, 18487, 18488:
			return "login", "SQL Server refused the login: " + msErr.Message, true
		case 4060:
			return "database", "The login cannot open that database: " + msErr.Message, true
		default:
			return "database", fmt.Sprintf("SQL Server answered: %s (error %d)", msErr.Message, msErr.Number), true
		}
	}
	lower := strings.ToLower(err.Error())
	if strings.Contains(lower, "server does not support encryption") || strings.Contains(lower, "encryption not supported") {
		return "tls", "The server does not offer encryption. Choose TLS off for this connection only if the server cannot speak it.", true
	}
	return "", "", false
}
