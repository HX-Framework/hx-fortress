package engine

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-sql-driver/mysql"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/secure"
)

// MySQL speaks to MySQL and MariaDB with go-sql-driver/mysql. A connection's database is one
// MySQL database (a schema), and its catalog is that database's tables.
type MySQL struct{}

// Open connects through the job's Dialer.
func (MySQL) Open(ctx context.Context, spec Spec) (*sql.DB, error) {
	j := spec.Job
	cfg := mysql.NewConfig()
	cfg.User = j.Login.User
	cfg.Passwd = j.Login.Password
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(j.Server.Host, strconv.Itoa(j.Server.Port))
	cfg.DBName = j.Database
	cfg.Timeout = ConnectTimeout
	cfg.DialFunc = spec.Dialer.DialContext
	cfg.ConnectionAttributes = "program_name:" + spec.appName()
	// A push's and a compare's statements bind hundreds of values: written into the statement by the
	// driver, each is one round trip to the server instead of a prepare, an execute and a close.
	// The driver refuses it only for character sets where a backslash can end a character, which a
	// connection with utf8mb4 never is.
	cfg.InterpolateParams = j.Kind == "push" || j.Kind == "compare"
	tlsConfig, err := secure.Config(j, spec.Capture)
	if err != nil {
		return nil, err
	}
	// With `off` (no TLS), the driver asks a MySQL 8 server for its RSA key and encrypts the
	// password with it, as MySQL's own clients do.
	cfg.TLS = tlsConfig
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, fmt.Errorf("the MySQL settings are not valid: %w", err)
	}
	return newPool(ctx, sql.OpenDB(connector))
}

// Version is "MySQL 8.4.3" or "MariaDB 11.4.4".
func (MySQL) Version(ctx context.Context, q Querier) (string, error) {
	var version, comment string
	err := q.QueryRowContext(ctx, `SELECT VERSION(), @@version_comment /* version */`).Scan(&version, &comment)
	if err != nil {
		return "", err
	}
	if strings.Contains(strings.ToLower(version+comment), "mariadb") {
		return firstLine("MariaDB " + strings.Split(version, "-")[0]), nil
	}
	return firstLine("MySQL " + version), nil
}

// A grant line of SHOW GRANTS: its privileges and what they are on. A name in backticks may hold
// spaces and dots (`my db`.`order items`), and a doubled backtick is one backtick.
const mysqlName = "(?:`(?:[^`]|``)*`|[^\\s.`]+)"

var mysqlGrantRe = regexp.MustCompile("(?i)^GRANT (.+?) ON (?:(?:TABLE|PROCEDURE|FUNCTION) )?(" + mysqlName + "(?:\\." + mysqlName + ")?) TO ")

// mysqlTarget splits a grant's target into its database and its table, unquoted: "*" for every one.
func mysqlTarget(target string) (db, table string) {
	parts := []string{}
	for len(target) > 0 {
		var part string
		if target[0] == '`' {
			end := 1
			for end < len(target) {
				if target[end] == '`' {
					if end+1 < len(target) && target[end+1] == '`' {
						end += 2
						continue
					}
					break
				}
				end++
			}
			part = strings.ReplaceAll(target[1:min(end, len(target))], "``", "`")
			target = target[min(end+1, len(target)):]
		} else {
			i := strings.IndexByte(target, '.')
			if i < 0 {
				i = len(target)
			}
			part, target = target[:i], target[i:]
		}
		parts = append(parts, part)
		target = strings.TrimPrefix(target, ".")
	}
	switch len(parts) {
	case 0:
		return "", ""
	case 1:
		return parts[0], ""
	}
	return parts[0], parts[1]
}

// Privileges that change data or shape. ALL is ALL PRIVILEGES.
var mysqlWritePrivileges = map[string]bool{
	"ALL": true, "ALL PRIVILEGES": true, "INSERT": true, "UPDATE": true, "DELETE": true,
	"CREATE": true, "DROP": true, "ALTER": true,
}

// Writes reads the login's grants (SHOW GRANTS, with the roles active in its session) and finds
// what they let it change in the connection's database.
func (MySQL) Writes(ctx context.Context, q Querier, database string) (WriteSet, error) {
	ws := WriteSet{Tables: map[string]bool{}, Powers: []string{}}
	grants, err := mysqlGrants(ctx, q)
	if err != nil {
		return ws, err
	}
	everyTable := false
	for _, line := range grants {
		m := mysqlGrantRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		var writes []string
		for _, p := range strings.Split(m[1], ",") {
			p = strings.ToUpper(strings.TrimSpace(p))
			// Column grants look like "UPDATE (col)": the privilege is the first word.
			if i := strings.Index(p, " ("); i > 0 {
				p = p[:i]
			}
			if mysqlWritePrivileges[p] {
				writes = append(writes, p)
			}
		}
		if len(writes) == 0 {
			continue
		}
		db, table := mysqlTarget(m[2])
		switch {
		case db == "*":
			ws.Powers = append(ws.Powers, strings.Join(writes, ", ")+" on *.*")
			everyTable = true
		case mysqlNameMatches(db, database) && table == "*":
			ws.Powers = append(ws.Powers, strings.Join(writes, ", ")+" on "+database+".*")
			everyTable = true
		case mysqlNameMatches(db, database):
			ws.Tables[tableKey(database, table)] = true
		}
	}
	if everyTable {
		rows, err := q.QueryContext(ctx, `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? /* writes:tables */`, database)
		if err != nil {
			return ws, err
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return ws, err
			}
			ws.Tables[tableKey(database, name)] = true
		}
		if err := rows.Err(); err != nil {
			return ws, err
		}
	}
	return ws, nil
}

// mysqlGrants is SHOW GRANTS for the login, expanded with the roles active in the session. MySQL 8
// names its active roles as accounts (`r`@`%`) and needs USING to show their grants; MariaDB names
// one bare role, has no USING, and shows the current role's grants in a plain SHOW GRANTS.
func mysqlGrants(ctx context.Context, q Querier) ([]string, error) {
	statement := "SHOW GRANTS /* writes:grants */"
	var roles sql.NullString
	if err := q.QueryRowContext(ctx, `SELECT CURRENT_ROLE() /* writes:roles */`).Scan(&roles); err == nil &&
		roles.Valid && strings.Contains(roles.String, "@") {
		statement = "SHOW GRANTS FOR CURRENT_USER() USING " + roles.String + " /* writes:grants */"
	}
	rows, err := q.QueryContext(ctx, statement)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var lines []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	return lines, rows.Err()
}

// mysqlNameMatches is a grant's database pattern against the connection's database: `_` and `%`
// are wildcards unless escaped with a backslash.
func mysqlNameMatches(pattern, name string) bool {
	var re strings.Builder
	re.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch {
		case c == '\\' && i+1 < len(pattern):
			i++
			re.WriteString(regexp.QuoteMeta(string(pattern[i])))
		case c == '%':
			re.WriteString(".*")
		case c == '_':
			re.WriteString(".")
		default:
			re.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	re.WriteString("$")
	ok, _ := regexp.MatchString(re.String(), name)
	return ok
}

// Catalog reads the database's tables (information_schema shows only what the login may see),
// their columns, and their primary keys. When the tables run past max, the columns and keys are
// read up to the last table kept: MySQL 5.7 and MariaDB open a table's files to answer for it.
func (MySQL) Catalog(ctx context.Context, q Querier, database string, max int, writes WriteSet) (job.Catalog, error) {
	b := newCatalogBuilder()
	rows, err := q.QueryContext(ctx, `SELECT TABLE_NAME, CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' ELSE 'table' END, TABLE_ROWS
FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
ORDER BY TABLE_NAME LIMIT ?
/* catalog:tables */`, database, max+1)
	if err != nil {
		return job.Catalog{}, err
	}
	count, truncated, last := 0, false, ""
	for rows.Next() {
		var name, kind string
		var estimate sql.NullInt64
		if err := rows.Scan(&name, &kind, &estimate); err != nil {
			rows.Close()
			return job.Catalog{}, err
		}
		count++
		if count > max {
			truncated = true
			break
		}
		last = name
		if kind == "view" {
			estimate = sql.NullInt64{}
		}
		b.addTable(job.Table{Schema: database, Name: name, Kind: kind, Rows: rowsOrNil(estimate)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return job.Catalog{}, err
	}

	bound, args := "", []any{database}
	if truncated {
		bound, args = " AND TABLE_NAME <= ?", append(args, last)
	}
	cols, err := q.QueryContext(ctx, `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`+bound+`
ORDER BY TABLE_NAME, ORDINAL_POSITION
/* catalog:columns */`, args...)
	if err != nil {
		return job.Catalog{}, err
	}
	for cols.Next() {
		var table, column, typ, nullable string
		if err := cols.Scan(&table, &column, &typ, &nullable); err != nil {
			cols.Close()
			return job.Catalog{}, err
		}
		b.addColumn(database, table, job.Column{Name: column, Type: typ, Nullable: strings.EqualFold(nullable, "YES")})
	}
	cols.Close()
	if err := cols.Err(); err != nil {
		return job.Catalog{}, err
	}

	keys, err := q.QueryContext(ctx, `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION
FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY'`+bound+`
/* catalog:keys */`, args...)
	if err != nil {
		return job.Catalog{}, err
	}
	defer keys.Close()
	for keys.Next() {
		var table, column string
		var position int
		if err := keys.Scan(&table, &column, &position); err != nil {
			return job.Catalog{}, err
		}
		b.setKey(database, table, column, position)
	}
	if err := keys.Err(); err != nil {
		return job.Catalog{}, err
	}
	return b.catalog("mysql", database, truncated, writes), nil
}

// Encryption is what the TLS handshake negotiated.
func (MySQL) Encryption(_ context.Context, _ Querier, spec Spec) job.Encryption {
	return spec.Capture.Encryption()
}

// Classify names MySQL's own errors by their number.
func (MySQL) Classify(err error) (string, string, bool) {
	var myErr *mysql.MySQLError
	if errors.As(err, &myErr) {
		switch myErr.Number {
		case 1045, 1698, 1251:
			return "login", "MySQL refused the login: " + myErr.Message, true
		case 1044, 1049:
			return "database", "The login cannot open that database: " + myErr.Message, true
		default:
			return "database", fmt.Sprintf("MySQL answered: %s (error %d)", myErr.Message, myErr.Number), true
		}
	}
	if errors.Is(err, mysql.ErrNoTLS) {
		return "tls", "The server does not accept TLS. Choose TLS off for this connection only if the server cannot speak it.", true
	}
	for _, sign := range []error{mysql.ErrCleartextPassword, mysql.ErrNativePassword, mysql.ErrOldPassword, mysql.ErrUnknownPlugin} {
		if errors.Is(err, sign) {
			return "login", "The server asks this login to sign in a way the data job does not use: " + trimDriverText(err.Error()), true
		}
	}
	return "", "", false
}
