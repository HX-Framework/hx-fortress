package engine

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	goora "github.com/sijms/go-ora/v2"
	"github.com/sijms/go-ora/v2/network"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/secure"
)

// Oracle speaks to Oracle Database with go-ora, a pure-Go driver that also speaks Oracle's own
// network encryption, so no Oracle Instant Client is in the image. A connection's database is the
// service name; its catalog is every table the login can read outside Oracle's own schemas.
type Oracle struct{}

// Open connects through the job's Dialer. TLS modes connect over TCPS with the job's TLS config;
// `off` asks for Oracle's own encryption and integrity, which servers that require it insist on.
func (Oracle) Open(ctx context.Context, spec Spec) (*sql.DB, error) {
	j := spec.Job
	options := map[string]string{
		"CONNECTION TIMEOUT": strconv.Itoa(int(ConnectTimeout.Seconds())),
	}
	tlsConfig, err := secure.Config(j, spec.Capture)
	if err != nil {
		return nil, err
	}
	if tlsConfig != nil {
		options["SSL"] = "true"
		options["SSL VERIFY"] = strconv.FormatBool(j.TLS.Mode != "require")
	} else {
		options["ENCRYPTION"] = "REQUESTED"
		options["DATA INTEGRITY"] = "REQUESTED"
	}
	connector := goora.NewConnector(goora.BuildUrl(j.Server.Host, j.Server.Port, j.Database, j.Login.User, j.Login.Password, options))
	oc := connector.(*goora.OracleConnector)
	oc.Dialer(spec.Dialer)
	if tlsConfig != nil {
		oc.WithTLSConfig(tlsConfig)
	}
	var opened driver.Connector = connector
	if spec.Dialer != nil && spec.Dialer.Until != nil {
		opened = steadyConnector{connector}
	}
	db, err := newPool(ctx, sql.OpenDB(opened))
	var parse *url.Error
	if errors.As(err, &parse) {
		// go-ora puts the settings in a URL, the password in it, and its parse error quotes that
		// URL whole: it is never repeated.
		return nil, oracleSettingsError{}
	}
	return db, err
}

// steadyConnector connects under a context that does not end. go-ora watches the context of a
// connect in a goroutine of its own, and when that context ends while the connect is still going,
// the goroutine closes the session that Connect goes on writing: a data race inside the driver
// (v2.9.0, network/session.go, StartContext and Connect). A job that is stopped in its login is
// such a connect. The job's end still ends a connect, through the Dialer: it closes a connection
// that is still in its login, ends a dial, and dials nothing after (reach.Dialer.Until). The
// driver's own connect timeout and the Dialer's bound the rest.
type steadyConnector struct{ driver.Connector }

func (c steadyConnector) Connect(ctx context.Context) (driver.Conn, error) {
	return c.Connector.Connect(context.WithoutCancel(ctx))
}

// oracleSettingsError is settings go-ora could not read, said without them.
type oracleSettingsError struct{}

func (oracleSettingsError) Error() string {
	return "the Oracle settings could not be read"
}

// Version is "Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production", from a view
// every login may read.
func (Oracle) Version(ctx context.Context, q Querier) (string, error) {
	var product, version string
	err := q.QueryRowContext(ctx, `SELECT PRODUCT, VERSION FROM PRODUCT_COMPONENT_VERSION WHERE PRODUCT LIKE 'Oracle%' AND ROWNUM = 1 /* version */`).Scan(&product, &version)
	if err != nil {
		return "", err
	}
	return firstLine(strings.TrimSpace(product) + " " + strings.TrimSpace(version)), nil
}

// Oracle's own schemas, for 11g, which has no ORACLE_MAINTAINED column to say so.
const oracleOwnSchemas = `'SYS','SYSTEM','OUTLN','DBSNMP','APPQOSSYS','DBSFWUSER','GGSYS','ANONYMOUS','CTXSYS',
  'DVSYS','DVF','GSMADMIN_INTERNAL','LBACSYS','MDSYS','OJVMSYS','OLAPSYS','ORDDATA','ORDPLUGINS','ORDSYS',
  'SI_INFORMTN_SCHEMA','WMSYS','XDB','XS$NULL','AUDSYS','GSMCATUSER','GSMUSER','MDDATA','REMOTE_SCHEDULER_AGENT',
  'SYSBACKUP','SYSDG','SYSKM','SYSRAC','SYS$UMF','EXFSYS','FLOWS_FILES','APEX_PUBLIC_USER','SPATIAL_CSW_ADMIN_USR',
  'SPATIAL_WFS_ADMIN_USR','MGMT_VIEW','OWBSYS','OWBSYS_AUDIT','ORACLE_OCM','DIP','PDBADMIN'`

// oracleMaintained reports whether the database marks its own schemas (ALL_USERS.ORACLE_MAINTAINED,
// 12c and later). A release names new schemas of its own; the mark covers them, the list does not.
func oracleMaintained(ctx context.Context, q Querier) bool {
	var marked int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM ALL_TAB_COLUMNS
WHERE OWNER = 'SYS' AND TABLE_NAME = 'ALL_USERS' AND COLUMN_NAME = 'ORACLE_MAINTAINED'
/* oracle:maintained */`).Scan(&marked)
	return err == nil && marked > 0
}

// oracleNotOwn is the filter that leaves Oracle's own schemas out, on column: the list (all an 11g
// has), and the schemas the database marks as its own when it marks them. Every login may write
// some of Oracle's own tables through PUBLIC (SYS.PLAN_TABLE$), which is no power over the data.
func oracleNotOwn(column string, maintained bool) string {
	filter := column + ` NOT IN (` + oracleOwnSchemas + `) AND ` + column + ` NOT LIKE 'APEX\_%' ESCAPE '\'`
	if maintained {
		filter += ` AND ` + column + ` NOT IN (SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'Y')`
	}
	return filter
}

// Writes reads the tables the login owns or may INSERT, UPDATE or DELETE (directly, through PUBLIC
// or through a role it holds), on the whole table or on some of its columns (ALL_COL_PRIVS), and
// the system privileges and roles that let it write anywhere.
func (Oracle) Writes(ctx context.Context, q Querier, _ string) (WriteSet, error) {
	ws := WriteSet{Tables: map[string]bool{}, Powers: []string{}}
	rows, err := q.QueryContext(ctx, `SELECT OWNER, TABLE_NAME FROM (
  SELECT OWNER, TABLE_NAME FROM ALL_TABLES WHERE OWNER = USER
  UNION
  SELECT TABLE_SCHEMA, TABLE_NAME FROM ALL_TAB_PRIVS
  WHERE PRIVILEGE IN ('INSERT', 'UPDATE', 'DELETE')
    AND (GRANTEE = USER OR GRANTEE = 'PUBLIC' OR GRANTEE IN (SELECT ROLE FROM SESSION_ROLES))
  UNION
  SELECT TABLE_SCHEMA, TABLE_NAME FROM ALL_COL_PRIVS
  WHERE PRIVILEGE IN ('INSERT', 'UPDATE')
    AND (GRANTEE = USER OR GRANTEE = 'PUBLIC' OR GRANTEE IN (SELECT ROLE FROM SESSION_ROLES))
) WHERE `+oracleNotOwn("OWNER", oracleMaintained(ctx, q))+`
/* writes:tables */`)
	if err != nil {
		return ws, err
	}
	defer rows.Close()
	for rows.Next() {
		var owner, name string
		if err := rows.Scan(&owner, &name); err != nil {
			return ws, err
		}
		ws.Tables[tableKey(owner, name)] = true
	}
	if err := rows.Err(); err != nil {
		return ws, err
	}

	powers, err := q.QueryContext(ctx, `SELECT PRIVILEGE FROM SESSION_PRIVS
WHERE PRIVILEGE IN ('INSERT ANY TABLE', 'UPDATE ANY TABLE', 'DELETE ANY TABLE', 'CREATE TABLE', 'CREATE ANY TABLE',
  'ALTER ANY TABLE', 'DROP ANY TABLE', 'SYSDBA')
UNION
SELECT ROLE FROM SESSION_ROLES WHERE ROLE IN ('DBA', 'RESOURCE', 'IMP_FULL_DATABASE', 'DATAPUMP_IMP_FULL_DATABASE')
/* writes:powers */`)
	if err != nil {
		return ws, err
	}
	defer powers.Close()
	for powers.Next() {
		var p string
		if err := powers.Scan(&p); err != nil {
			return ws, err
		}
		ws.Powers = append(ws.Powers, p)
	}
	return ws, powers.Err()
}

// oracleTables is the catalog's tables and views, first by owner and name, at most :1 of them.
// NUM_ROWS is the statistics' estimate; a view has none. ROWNUM keeps it working on 11g.
func oracleTables(maintained bool) string {
	return `SELECT * FROM (
  SELECT OWNER, TABLE_NAME AS OBJECT_NAME, 'table' AS KIND, NUM_ROWS FROM ALL_TABLES WHERE ` + oracleNotOwn("OWNER", maintained) + ` AND NESTED = 'NO'
  UNION ALL
  SELECT OWNER, VIEW_NAME, 'view', NULL FROM ALL_VIEWS WHERE ` + oracleNotOwn("OWNER", maintained) + `
  ORDER BY 1, 2
) WHERE ROWNUM <= :1`
}

// Catalog reads the tables, their columns, and their primary keys.
func (Oracle) Catalog(ctx context.Context, q Querier, database string, max int, writes WriteSet) (job.Catalog, error) {
	b := newCatalogBuilder()
	maintained := oracleMaintained(ctx, q)
	rows, err := q.QueryContext(ctx, oracleTables(maintained)+"\n/* catalog:tables */", max+1)
	if err != nil {
		return job.Catalog{}, err
	}
	count, truncated := 0, false
	for rows.Next() {
		var owner, name, kind string
		var estimate sql.NullInt64
		if err := rows.Scan(&owner, &name, &kind, &estimate); err != nil {
			rows.Close()
			return job.Catalog{}, err
		}
		count++
		if count > max {
			truncated = true
			break
		}
		b.addTable(job.Table{Schema: owner, Name: name, Kind: kind, Rows: rowsOrNil(estimate)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return job.Catalog{}, err
	}

	cols, err := q.QueryContext(ctx, `SELECT c.OWNER, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.CHAR_LENGTH,
  c.DATA_PRECISION, c.DATA_SCALE, c.NULLABLE
FROM ALL_TAB_COLUMNS c JOIN (`+oracleTables(maintained)+`) t ON t.OWNER = c.OWNER AND t.OBJECT_NAME = c.TABLE_NAME
ORDER BY c.OWNER, c.TABLE_NAME, c.COLUMN_ID
/* catalog:columns */`, max)
	if err != nil {
		return job.Catalog{}, err
	}
	for cols.Next() {
		var owner, table, column, typ, nullable string
		var length, charLength, precision, scale sql.NullInt64
		if err := cols.Scan(&owner, &table, &column, &typ, &length, &charLength, &precision, &scale, &nullable); err != nil {
			cols.Close()
			return job.Catalog{}, err
		}
		if !b.has(owner, table) {
			continue
		}
		b.addColumn(owner, table, job.Column{Name: column, Type: oracleType(typ, length, charLength, precision, scale), Nullable: nullable == "Y"})
	}
	cols.Close()
	if err := cols.Err(); err != nil {
		return job.Catalog{}, err
	}

	keys, err := q.QueryContext(ctx, `SELECT cc.OWNER, cc.TABLE_NAME, cc.COLUMN_NAME, cc.POSITION
FROM ALL_CONSTRAINTS k JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = k.OWNER AND cc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
WHERE k.CONSTRAINT_TYPE = 'P' AND `+oracleNotOwn("k.OWNER", maintained)+`
/* catalog:keys */`)
	if err != nil {
		return job.Catalog{}, err
	}
	defer keys.Close()
	for keys.Next() {
		var owner, table, column string
		var position int
		if err := keys.Scan(&owner, &table, &column, &position); err != nil {
			return job.Catalog{}, err
		}
		b.setKey(owner, table, column, position)
	}
	if err := keys.Err(); err != nil {
		return job.Catalog{}, err
	}
	return b.catalog("oracle", database, truncated, writes), nil
}

// oracleType writes a column's type the way Oracle's own tools do: "VARCHAR2(50)", "NUMBER(10,2)", "DATE".
func oracleType(name string, length, charLength, precision, scale sql.NullInt64) string {
	switch name {
	case "VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR":
		if charLength.Valid && charLength.Int64 > 0 {
			return fmt.Sprintf("%s(%d)", name, charLength.Int64)
		}
	case "RAW":
		if length.Valid {
			return fmt.Sprintf("%s(%d)", name, length.Int64)
		}
	case "NUMBER":
		switch {
		case precision.Valid && scale.Valid && scale.Int64 != 0:
			return fmt.Sprintf("NUMBER(%d,%d)", precision.Int64, scale.Int64)
		case precision.Valid:
			return fmt.Sprintf("NUMBER(%d)", precision.Int64)
		}
	}
	return name
}

// oracleBannerAlgorithm finds the encryption algorithm in a network service banner such as
// "AES256 Encryption service adapter for Linux: Version 19.0.0.0.0 - Production".
var oracleBannerAlgorithm = regexp.MustCompile(`(?i)^(AES\d+|3DES\d*|DES\d*|RC4_\d+)\b.*encryption service adapter`)

// Encryption is TLS when the connection went over TCPS. Without TLS, Oracle's own encryption is
// read from the session's network banners, which only a login allowed to read V$SESSION_CONNECT_INFO
// sees; any other login reports none.
func (Oracle) Encryption(ctx context.Context, q Querier, spec Spec) job.Encryption {
	if spec.Job.TLS.Mode != "off" {
		return spec.Capture.Encryption()
	}
	rows, err := q.QueryContext(ctx, `SELECT NETWORK_SERVICE_BANNER FROM V$SESSION_CONNECT_INFO
WHERE SID = SYS_CONTEXT('USERENV', 'SID') /* encryption:banners */`)
	if err != nil {
		return job.Encryption{Kind: "none"}
	}
	defer rows.Close()
	for rows.Next() {
		var banner sql.NullString
		if rows.Scan(&banner) != nil || !banner.Valid {
			continue
		}
		if m := oracleBannerAlgorithm.FindStringSubmatch(strings.TrimSpace(banner.String)); m != nil {
			return job.Encryption{Kind: "oracle", Version: job.Str(strings.ToUpper(m[1])), Verified: false}
		}
	}
	return job.Encryption{Kind: "none"}
}

// An ORA- error code at the start of a driver message.
var oraCodeRe = regexp.MustCompile(`ORA-(\d{5})`)

// Classify names Oracle's own errors by their ORA- number.
func (Oracle) Classify(err error) (string, string, bool) {
	if errors.As(err, &oracleSettingsError{}) {
		return "database", "The Oracle settings could not be read. The server's host must be a name or an address, without a port, and the database a service name.", true
	}
	var oraErr *network.OracleError
	text := err.Error()
	code := 0
	if errors.As(err, &oraErr) {
		code = oraErr.ErrCode
		text = oraErr.ErrMsg
	} else if m := oraCodeRe.FindStringSubmatch(text); m != nil {
		code, _ = strconv.Atoi(m[1])
	}
	switch code {
	case 0:
		return "", "", false
	case 1017, 28000, 28001, 1005:
		return "login", "Oracle refused the login: " + trimDriverText(text), true
	case 12514, 12505, 12516, 12519:
		return "database", "The listener does not know that service: " + trimDriverText(text), true
	default:
		return "database", "Oracle answered: " + trimDriverText(text), true
	}
}

// OracleDefinitionChanged reports whether err is Oracle's ORA-01466, "unable to read data - table
// definition has changed": a read-only transaction read a table or index as of a moment Oracle
// counts as before the table's last change, which can be one the transaction began after. Oracle's
// remedy is to end the transaction and run the statement again. The driver's code decides, never a
// message that may quote the statement.
func OracleDefinitionChanged(err error) bool {
	var oraErr *network.OracleError
	if errors.As(err, &oraErr) {
		return oraErr.ErrCode == 1466
	}
	return err != nil && strings.HasPrefix(err.Error(), "ORA-01466")
}
