package engine

import (
	"context"
	"crypto/tls"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
	mssql "github.com/microsoft/go-mssqldb"
	"github.com/sijms/go-ora/v2/network"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/reach"
	"hx-fortress/data-runner/internal/secure"
)

func names(c job.Catalog) []string {
	out := []string{}
	for _, t := range c.Tables {
		out = append(out, t.Schema+"."+t.Name)
	}
	return out
}

func find(c job.Catalog, schema, name string) job.Table {
	for _, t := range c.Tables {
		if t.Schema == schema && t.Name == name {
			return t
		}
	}
	return job.Table{}
}

// ─── Postgres ──────────────────────────────────────────────────────────────

func TestPostgresCatalogAndWrites(t *testing.T) {
	db, f := newFake(t, map[string]answer{
		"writes:tables": {cols: []string{"nspname", "relname"}, rows: [][]driver.Value{row("public", "fees")}},
		"writes:powers": {cols: []string{"a", "b", "c", "d", "e", "f", "g", "h"}, rows: [][]driver.Value{row(false, false, false, false, false, "public", false, false)}},
		"catalog:tables": {cols: []string{"oid", "nspname", "relname", "kind", "rows"}, rows: [][]driver.Value{
			row(int64(1), "public", "fees", "table", int64(12)),
			row(int64(2), "public", "open_permits", "view", nil),
			row(int64(3), "public", "permits", "table", int64(812331)),
		}},
		"catalog:columns": {cols: []string{"s", "t", "c", "type", "null", "key"}, rows: [][]driver.Value{
			row("public", "fees", "fee_id", "integer", false, int64(1)),
			row("public", "fees", "amount", "numeric(10,2)", true, int64(0)),
			row("public", "permits", "permit_number", "text", false, int64(1)),
			row("public", "permits", "town_id", "integer", false, int64(2)),
			row("public", "ghost", "x", "integer", true, int64(0)), // not in the kept tables
		}},
	})
	pg := Postgres{}
	writes, err := pg.Writes(ctx, db, "permits")
	if err != nil {
		t.Fatal(err)
	}
	if !writes.Tables["public.fees"] || !reflect.DeepEqual(writes.Powers, []string{"CREATE in schema public"}) {
		t.Fatalf("writes %+v", writes)
	}
	// A grant on some columns counts, a partition counts as its parent, and a schema the login may
	// not use makes nothing in it writable.
	for _, part := range []string{"has_any_column_privilege(c.oid, 'INSERT')", "has_any_column_privilege(c.oid, 'UPDATE')", "NOT c.relispartition", "has_schema_privilege(n.oid, 'USAGE')"} {
		if !strings.Contains(f.said["writes:tables"], part) {
			t.Fatalf("the write check lacks %s", part)
		}
	}
	cat, err := pg.Catalog(ctx, db, "permits", 2, writes)
	if err != nil {
		t.Fatal(err)
	}
	if !cat.Truncated || !reflect.DeepEqual(names(cat), []string{"public.fees", "public.open_permits"}) {
		t.Fatalf("catalog %v truncated %t", names(cat), cat.Truncated)
	}
	if got := f.asked["catalog:tables"]; len(got) != 1 || got[0] != int64(3) {
		t.Fatalf("asked for %v tables; one more than kept tells a cut catalog", got)
	}
	fees := find(cat, "public", "fees")
	if !fees.Writable || fees.Rows == nil || *fees.Rows != 12 || len(fees.Columns) != 2 || fees.Columns[0].Key != 1 || fees.Columns[1].Key != 0 || !fees.Columns[1].Nullable {
		t.Fatalf("fees %+v", fees)
	}
	if v := find(cat, "public", "open_permits"); v.Kind != "view" || v.Rows != nil || v.Writable || v.Columns == nil {
		t.Fatalf("view %+v", v)
	}
	check := WriteCheck(writes, 20)
	if !check.CanWrite || check.WritableCount != 1 || !reflect.DeepEqual(check.WritableTables, []string{"public.fees"}) {
		t.Fatalf("check %+v", check)
	}
}

func TestPostgresPowersNameEveryWayToWrite(t *testing.T) {
	db, _ := newFake(t, map[string]answer{
		"writes:tables": {cols: []string{"nspname", "relname"}},
		"writes:powers": {cols: []string{"a", "b", "c", "d", "e", "f", "g", "h"}, rows: [][]driver.Value{row(true, true, true, true, true, "", true, true)}},
	})
	writes, err := Postgres{}.Writes(ctx, db, "x")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"superuser", "pg_write_all_data", "pg_write_server_files", "pg_execute_server_program", "CREATEROLE", "CREATEDB", "CREATE on the database"}
	if !reflect.DeepEqual(writes.Powers, want) {
		t.Fatalf("powers %v", writes.Powers)
	}
	if c := WriteCheck(writes, 20); !c.CanWrite || c.WritableCount != 0 {
		t.Fatalf("check %+v", c)
	}
}

// A login that may write a file on the server's host, or run a program there, is no login that can
// only read, though it may write no table: COPY does both, and a read-only transaction stops
// neither. Each role is asked for by its own name, and only on a server that has it.
func TestPostgresCountsTheRolesThatReachTheServersHost(t *testing.T) {
	for _, c := range []struct {
		files, programs bool
		want            []string
	}{
		{true, false, []string{"pg_write_server_files"}},
		{false, true, []string{"pg_execute_server_program"}},
		{false, false, []string{}},
	} {
		db, f := newFake(t, map[string]answer{
			"writes:tables": {cols: []string{"nspname", "relname"}},
			"writes:powers": {cols: []string{"a", "b", "c", "d", "e", "f", "g", "h"}, rows: [][]driver.Value{row(false, false, false, false, false, "", c.files, c.programs)}},
		})
		writes, err := Postgres{}.Writes(ctx, db, "x")
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(writes.Powers, c.want) {
			t.Fatalf("powers %v, want %v", writes.Powers, c.want)
		}
		if check := WriteCheck(writes, 20); check.CanWrite != (len(c.want) > 0) || check.WritableCount != 0 {
			t.Fatalf("check %+v", check)
		}
		said := f.said["writes:powers"]
		for _, role := range []string{"pg_write_all_data", "pg_write_server_files", "pg_execute_server_program"} {
			// Asked only where the role is: a Postgres older than the role has no row of that name.
			guard := "CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '" + role + "')"
			asks := "pg_has_role(current_user, (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '" + role + "'), 'USAGE')"
			if !strings.Contains(said, guard) || !strings.Contains(said, asks) {
				t.Fatalf("the powers are read without %s: %s", role, said)
			}
		}
	}
}

func TestPostgresClassifiesByState(t *testing.T) {
	cases := map[string]string{"28P01": "login", "28000": "login", "3D000": "database", "42501": "database"}
	for state, want := range cases {
		code, msg, ok := Postgres{}.Classify(fmt.Errorf("connect: %w", &pgconn.PgError{Code: state, Message: "nope"}))
		if !ok || code != want || !strings.Contains(msg, "nope") {
			t.Errorf("%s: %s %q %t", state, code, msg, ok)
		}
	}
	if code, _, _ := (Postgres{}).Classify(errors.New("server refused TLS connection")); code != "tls" {
		t.Errorf("no TLS: %s", code)
	}
}

// ─── SQL Server ────────────────────────────────────────────────────────────

func TestSQLServerCatalogAndWrites(t *testing.T) {
	db, f := newFake(t, map[string]answer{
		"writes:tables":  {cols: []string{"s", "o"}, rows: [][]driver.Value{row("dbo", "permits"), row("dbo", "inspections")}},
		"writes:columns": {cols: []string{"s", "o"}, rows: [][]driver.Value{row("dbo", "contacts")}},
		"writes:powers":  {cols: []string{"a", "b", "c", "d", "e", "f"}, rows: [][]driver.Value{row(int64(0), int64(0), int64(1), int64(0), nil, int64(0))}},
		"catalog:tables": {cols: []string{"id", "s", "o", "kind", "est"}, rows: [][]driver.Value{
			row(int64(10), "dbo", "permits", "table", int64(812331)),
			row(int64(11), "dbo", "open_permits", "view", nil),
		}},
		"catalog:columns": {cols: []string{"s", "t", "c", "type", "len", "prec", "scale", "null", "key"}, rows: [][]driver.Value{
			row("dbo", "permits", "permit_number", "nvarchar", int64(40), int64(0), int64(0), false, int64(1)),
			row("dbo", "permits", "notes", "varchar", int64(-1), int64(0), int64(0), true, int64(0)),
			row("dbo", "permits", "fee", "decimal", int64(9), int64(10), int64(2), true, int64(0)),
			row("dbo", "permits", "issued_at", "datetime2", int64(8), int64(27), int64(7), true, int64(0)),
			row("dbo", "open_permits", "permit_number", "nvarchar", int64(40), int64(0), int64(0), false, int64(0)),
			// A type the login may not see reads as NULL; the catalog still reads.
			row("dbo", "open_permits", "phone", nil, int64(50), int64(0), int64(0), true, int64(0)),
		}},
	})
	ms := SQLServer{}
	writes, err := ms.Writes(ctx, db, "Permits")
	if err != nil {
		t.Fatal(err)
	}
	// A column's UPDATE grant makes its table writable too.
	if len(writes.Tables) != 3 || !writes.Tables["dbo.contacts"] || !reflect.DeepEqual(writes.Powers, []string{"db_datawriter"}) {
		t.Fatalf("writes %+v", writes)
	}
	cat, err := ms.Catalog(ctx, db, "Permits", 100, writes)
	if err != nil {
		t.Fatal(err)
	}
	p := find(cat, "dbo", "permits")
	types := []string{}
	for _, c := range p.Columns {
		types = append(types, c.Type)
	}
	if !reflect.DeepEqual(types, []string{"nvarchar(20)", "varchar(max)", "decimal(10,2)", "datetime2(7)"}) {
		t.Fatalf("types %v", types)
	}
	if !p.Writable || p.Columns[0].Key != 1 || cat.Truncated || cat.Engine != "sqlserver" {
		t.Fatalf("permits %+v", p)
	}
	if v := find(cat, "dbo", "open_permits"); len(v.Columns) != 2 || v.Columns[1].Type != "unknown" {
		t.Fatalf("open_permits %+v", v)
	}
	// The columns are read by the kept tables' ids, never by running the tables' query again.
	if asked := f.asked["catalog:columns"]; !reflect.DeepEqual(asked, []driver.Value{int64(10), int64(11)}) {
		t.Fatalf("columns asked for %v", asked)
	}
}

// Refused is the server saying no to this login on this database, and nothing else: a full server,
// a server starting up or a broken connection says nothing about the database.
func TestRefusedIsTheServerSayingNoToTheDatabase(t *testing.T) {
	wrap := func(err error) error { return fmt.Errorf("connect: %w", err) }
	cases := []struct {
		name    string
		engine  Engine
		err     error
		refused bool
	}{
		{"postgres access rule", Postgres{}, wrap(&pgconn.PgError{Code: "28000", Message: "pg_hba.conf rejects connection"}), true},
		{"postgres password", Postgres{}, wrap(&pgconn.PgError{Code: "28P01"}), true},
		{"postgres no database", Postgres{}, wrap(&pgconn.PgError{Code: "3D000"}), true},
		{"postgres no CONNECT", Postgres{}, wrap(&pgconn.PgError{Code: "42501"}), true},
		{"postgres takes no connections", Postgres{}, wrap(&pgconn.PgError{Code: "55000"}), true},
		{"postgres full", Postgres{}, wrap(&pgconn.PgError{Code: "53300"}), false},
		{"postgres starting up", Postgres{}, wrap(&pgconn.PgError{Code: "57P03"}), false},
		{"postgres broken path", Postgres{}, errors.New("unexpected EOF"), false},
		{"mysql database", MySQL{}, wrap(&mysql.MySQLError{Number: 1044}), true},
		{"mysql login", MySQL{}, wrap(&mysql.MySQLError{Number: 1045}), true},
		{"mysql no database", MySQL{}, wrap(&mysql.MySQLError{Number: 1049}), true},
		{"mysql full", MySQL{}, wrap(&mysql.MySQLError{Number: 1040}), false},
		{"sqlserver database", SQLServer{}, wrap(mssql.Error{Number: 4060}), true},
		{"sqlserver login", SQLServer{}, wrap(mssql.Error{Number: 18456}), true},
		{"sqlserver no access", SQLServer{}, wrap(mssql.Error{Number: 916}), true},
		{"sqlserver busy", SQLServer{}, wrap(mssql.Error{Number: 10928}), false},
		{"oracle", Oracle{}, errors.New("ORA-01017: invalid username/password"), false},
	}
	for _, c := range cases {
		if got := c.engine.Refused(c.err); got != c.refused {
			t.Errorf("%s: Refused %t", c.name, got)
		}
	}
}

func TestSQLServerClassifiesByNumber(t *testing.T) {
	code, _, ok := SQLServer{}.Classify(mssql.Error{Number: 18456, Message: "Login failed for user 'reader'."})
	if !ok || code != "login" {
		t.Fatalf("login: %s %t", code, ok)
	}
	code, _, _ = SQLServer{}.Classify(fmt.Errorf("open: %w", mssql.Error{Number: 4060, Message: "Cannot open database"}))
	if code != "database" {
		t.Fatalf("database: %s", code)
	}
}

func TestSQLServerConfigKeepsTheServersNameAndTheModesEncryption(t *testing.T) {
	j := job.Job{Engine: "sqlserver", Database: "Permits", Server: job.HostPort{Host: "sql-01.example.internal", Port: 1433},
		TLS: job.TLS{Mode: "strict", MinVersion: "1.2"}, Login: job.Login{Kind: "read", User: "reader", Password: "p@ss;word="}}
	cfg, err := msConfig(Spec{Job: j, Capture: &secure.Capture{}})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "sql-01.example.internal" || cfg.Port != 1433 || cfg.Password != "p@ss;word=" || cfg.Database != "Permits" {
		t.Fatalf("config %+v", cfg)
	}
	// The dial has the time every engine's connect has: a job says "within 30 seconds" of a server
	// that did not answer, whichever part of the connect ran out of time.
	if cfg.DialTimeout != ConnectTimeout {
		t.Fatalf("the dial has %s, and a connect has %s", cfg.DialTimeout, ConnectTimeout)
	}
	// The certificate check is the config's own VerifyConnection, against the server's name.
	if !cfg.HostInCertificateProvided || cfg.TLSConfig == nil || cfg.TLSConfig.ServerName != "sql-01.example.internal" || cfg.TLSConfig.VerifyConnection == nil {
		t.Fatalf("TLS %+v", cfg.TLSConfig)
	}
	if fmt.Sprint(cfg.Encryption) != fmt.Sprint(4) { // EncryptionStrict
		t.Fatalf("encryption %v", cfg.Encryption)
	}
	j.TLS.Mode = "off"
	cfg, _ = msConfig(Spec{Job: j, Capture: &secure.Capture{}})
	if fmt.Sprint(cfg.Encryption) != fmt.Sprint(0) || cfg.TLSConfig == nil || !cfg.TLSConfig.InsecureSkipVerify { // EncryptionOff: the login alone
		t.Fatalf("off: encryption %v, TLS %+v", cfg.Encryption, cfg.TLSConfig)
	}
	// With `off`, the server says whether it encrypted the whole session anyway (Force Encryption).
	t.Run("login only", func(t *testing.T) {
		db, _ := newFake(t, map[string]answer{"encryption": {cols: []string{"e"}, rows: [][]driver.Value{row("FALSE")}}})
		if enc := (SQLServer{}).Encryption(ctx, db, Spec{Job: j, Capture: handshaken(t)}); enc.Kind != "none" {
			t.Fatalf("off reads as %+v", enc)
		}
	})
	t.Run("forced by the server", func(t *testing.T) {
		db, _ := newFake(t, map[string]answer{"encryption": {cols: []string{"e"}, rows: [][]driver.Value{row("TRUE")}}})
		if enc := (SQLServer{}).Encryption(ctx, db, Spec{Job: j, Capture: handshaken(t)}); enc.Kind != "tls" || enc.Verified {
			t.Fatalf("forced reads as %+v", enc)
		}
	})
}

// handshaken is a capture that saw one TLS handshake, made with an unchecked (`require`) config.
func handshaken(t *testing.T) *secure.Capture {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(srv.Close)
	capture := &secure.Capture{}
	cfg, err := secure.Config(job.Job{Server: job.HostPort{Host: "sql-01.example.internal"}, TLS: job.TLS{Mode: "require", MinVersion: "1.2"}}, capture)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "https://"))
	if err != nil {
		t.Fatal(err)
	}
	conn := tls.Client(raw, cfg)
	defer conn.Close()
	if err := conn.Handshake(); err != nil {
		t.Fatal(err)
	}
	return capture
}

// ─── MySQL ─────────────────────────────────────────────────────────────────

func TestMySQLWritesFromGrants(t *testing.T) {
	db, f := newFake(t, map[string]answer{
		"writes:roles": {cols: []string{"r"}, rows: [][]driver.Value{row("`app_rw`@`%`")}},
		"writes:grants": {cols: []string{"g"}, rows: [][]driver.Value{
			row("GRANT USAGE ON *.* TO `permits_reader`@`%`"),
			row("GRANT SELECT ON `permits`.* TO `permits_reader`@`%`"),
			row("GRANT SELECT, INSERT, UPDATE (status) ON `permits`.`fees` TO `permits_reader`@`%`"),
			row("GRANT SELECT ON `other`.* TO `permits_reader`@`%`"),
			row("GRANT `app_rw`@`%` TO `permits_reader`@`%`"),
		}},
	})
	writes, err := MySQL{}.Writes(ctx, db, "permits")
	if err != nil {
		t.Fatal(err)
	}
	if !writes.Tables["permits.fees"] || len(writes.Tables) != 1 || len(writes.Powers) != 0 {
		t.Fatalf("writes %+v", writes)
	}
	// MySQL 8 names its active roles as accounts, and shows their grants with USING.
	if said := f.said["writes:grants"]; !strings.Contains(said, "USING `app_rw`@`%`") {
		t.Fatalf("grants read with %q", said)
	}
}

func TestMySQLGrantsOnMariaDBAndOnQuotedNames(t *testing.T) {
	db, f := newFake(t, map[string]answer{
		// MariaDB names one bare role and has no USING: a plain SHOW GRANTS shows the role's grants.
		"writes:roles": {cols: []string{"r"}, rows: [][]driver.Value{row("app_rw")}},
		"writes:grants": {cols: []string{"g"}, rows: [][]driver.Value{
			row("GRANT INSERT ON `shop`.`order items` TO `x`@`%`"),
			row("GRANT UPDATE (`note`) ON `shop`.`a.b` TO `x`@`%`"),
			row("GRANT INSERT ON `my.shop`.`fees` TO `x`@`%`"),
			row("GRANT SELECT ON `shop`.`ro``table` TO `x`@`%`"),
			row("GRANT DELETE ON `shop`.`it``s` TO `x`@`%`"),
		}},
	})
	writes, err := MySQL{}.Writes(ctx, db, "shop")
	if err != nil {
		t.Fatal(err)
	}
	if said := f.said["writes:grants"]; strings.Contains(said, "USING") {
		t.Fatalf("MariaDB's grants read with %q", said)
	}
	want := map[string]bool{"shop.order items": true, "shop.a.b": true, "shop.it`s": true}
	if !reflect.DeepEqual(writes.Tables, want) {
		t.Fatalf("writes %+v", writes.Tables)
	}
	if db, table := mysqlTarget("`my db`.*"); db != "my db" || table != "*" {
		t.Fatalf("target %q %q", db, table)
	}
}

func TestMySQLReadsColumnsOnlyUpToTheLastTableKept(t *testing.T) {
	db, f := newFake(t, map[string]answer{
		"catalog:tables":  {cols: []string{"n", "k", "r"}, rows: [][]driver.Value{row("a", "table", int64(1)), row("b", "table", int64(1)), row("c", "table", int64(1))}},
		"catalog:columns": {cols: []string{"t", "c", "type", "null"}, rows: [][]driver.Value{row("a", "id", "int", "NO")}},
		"catalog:keys":    {cols: []string{"t", "c", "p"}, rows: [][]driver.Value{}},
	})
	cat, err := MySQL{}.Catalog(ctx, db, "shop", 2, WriteSet{})
	if err != nil {
		t.Fatal(err)
	}
	if !cat.Truncated || len(cat.Tables) != 2 {
		t.Fatalf("catalog %+v", cat)
	}
	for _, tag := range []string{"catalog:columns", "catalog:keys"} {
		if !reflect.DeepEqual(f.asked[tag], []driver.Value{"shop", "b"}) || !strings.Contains(f.said[tag], "TABLE_NAME <= ?") {
			t.Fatalf("%s asked %v with %q", tag, f.asked[tag], f.said[tag])
		}
	}
}

func TestMySQLDatabaseWideGrantMakesEveryTableWritable(t *testing.T) {
	db, _ := newFake(t, map[string]answer{
		"writes:roles":  {cols: []string{"r"}, rows: [][]driver.Value{row("NONE")}},
		"writes:grants": {cols: []string{"g"}, rows: [][]driver.Value{row("GRANT ALL PRIVILEGES ON `perm\\_its`.* TO `x`@`%`")}},
		"writes:tables": {cols: []string{"t"}, rows: [][]driver.Value{row("fees"), row("permits")}},
	})
	writes, err := MySQL{}.Writes(ctx, db, "perm_its")
	if err != nil {
		t.Fatal(err)
	}
	if len(writes.Tables) != 2 || !reflect.DeepEqual(writes.Powers, []string{"ALL PRIVILEGES on perm_its.*"}) {
		t.Fatalf("writes %+v", writes)
	}
}

// FILE lets a SELECT write a file on the server's host (INTO OUTFILE), which a read-only
// transaction does not stop. It is a power of its own: it makes no table writable.
func TestMySQLCountsTheFilePrivilege(t *testing.T) {
	cases := []struct {
		name   string
		grants []string
		tables []string // what the database holds, read only when a grant covers every table
		powers []string
		count  int
	}{
		{"with SELECT only", []string{"GRANT SELECT, FILE ON *.* TO `x`@`%`"}, nil, []string{"FILE on *.*"}, 0},
		{"alone, beside a database's SELECT", []string{"GRANT FILE ON *.* TO `x`@`%`", "GRANT SELECT ON `permits`.* TO `x`@`%`"}, nil, []string{"FILE on *.*"}, 0},
		{"as MariaDB prints a grant", []string{"GRANT FILE ON *.* TO `x`@`%` IDENTIFIED BY PASSWORD '*00'"}, nil, []string{"FILE on *.*"}, 0},
		{"with a privilege that writes tables", []string{"GRANT INSERT, FILE ON *.* TO `x`@`%`"}, []string{"fees", "permits"}, []string{"INSERT, FILE on *.*"}, 2},
		{"inside ALL PRIVILEGES", []string{"GRANT ALL PRIVILEGES ON *.* TO `x`@`%`"}, []string{"fees"}, []string{"ALL PRIVILEGES on *.*"}, 1},
		{"not held", []string{"GRANT SELECT, PROCESS ON *.* TO `x`@`%`", "GRANT SELECT ON `permits`.* TO `x`@`%`"}, nil, []string{}, 0},
		{"a column named like it", []string{"GRANT SELECT (`file`) ON `permits`.`uploads` TO `x`@`%`"}, nil, []string{}, 0},
		{"two columns, one named like it", []string{"GRANT SELECT (`name`, `file`), UPDATE (`file`) ON `other`.`uploads` TO `x`@`%`"}, nil, []string{}, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var grants, tables [][]driver.Value
			for _, g := range c.grants {
				grants = append(grants, row(g))
			}
			for _, name := range c.tables {
				tables = append(tables, row(name))
			}
			answers := map[string]answer{
				"writes:roles":  {cols: []string{"r"}, rows: [][]driver.Value{row("NONE")}},
				"writes:grants": {cols: []string{"g"}, rows: grants},
			}
			if c.tables != nil {
				answers["writes:tables"] = answer{cols: []string{"t"}, rows: tables}
			}
			db, f := newFake(t, answers)
			writes, err := MySQL{}.Writes(ctx, db, "permits")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(writes.Powers, c.powers) {
				t.Fatalf("powers %v, want %v", writes.Powers, c.powers)
			}
			check := WriteCheck(writes, 20)
			if check.CanWrite != (len(c.powers) > 0) || check.WritableCount != c.count {
				t.Fatalf("check %+v", check)
			}
			// FILE alone makes no table writable, so the database's tables are not even read.
			if _, read := f.said["writes:tables"]; read != (c.tables != nil) {
				t.Fatalf("the database's tables were read: %t", read)
			}
		})
	}
}

func TestMySQLNamePatterns(t *testing.T) {
	cases := []struct {
		pattern, name string
		want          bool
	}{
		{"permits", "permits", true}, {"perm%", "permits", true}, {"perm_ts", "permits", true},
		{`perm\_ts`, "permits", false}, {`perm\_ts`, "perm_ts", true}, {"other", "permits", false},
	}
	for _, c := range cases {
		if got := mysqlNameMatches(c.pattern, c.name); got != c.want {
			t.Errorf("%q vs %q: %t", c.pattern, c.name, got)
		}
	}
}

func TestMySQLCatalogKeysAndClassify(t *testing.T) {
	db, _ := newFake(t, map[string]answer{
		"catalog:tables": {cols: []string{"n", "k", "r"}, rows: [][]driver.Value{row("fees", "table", int64(4)), row("v_fees", "view", int64(9))}},
		"catalog:columns": {cols: []string{"t", "c", "type", "null"}, rows: [][]driver.Value{
			row("fees", "id", "int unsigned", "NO"), row("fees", "town", "varchar(40)", "YES"), row("v_fees", "id", "int unsigned", "NO"),
		}},
		"catalog:keys": {cols: []string{"t", "c", "p"}, rows: [][]driver.Value{row("fees", "id", int64(1))}},
	})
	cat, err := MySQL{}.Catalog(ctx, db, "permits", 10, WriteSet{Tables: map[string]bool{"permits.fees": true}})
	if err != nil {
		t.Fatal(err)
	}
	fees := find(cat, "permits", "fees")
	if !fees.Writable || fees.Columns[0].Key != 1 || fees.Columns[1].Key != 0 || !fees.Columns[1].Nullable {
		t.Fatalf("fees %+v", fees)
	}
	if v := find(cat, "permits", "v_fees"); v.Rows != nil {
		t.Fatalf("a view's estimate %v", *v.Rows)
	}
	if code, _, _ := (MySQL{}).Classify(&mysql.MySQLError{Number: 1045, Message: "Access denied"}); code != "login" {
		t.Fatalf("1045: %s", code)
	}
	if code, _, _ := (MySQL{}).Classify(mysql.ErrNoTLS); code != "tls" {
		t.Fatalf("no TLS: %s", code)
	}
	// A sign-in method the driver will not use is the login's answer, not an unreachable server.
	if code, _, _ := (MySQL{}).Classify(fmt.Errorf("connect: %w", mysql.ErrCleartextPassword)); code != "login" {
		t.Fatalf("cleartext: %s", code)
	}
}

// ─── Oracle ────────────────────────────────────────────────────────────────

func TestOracleCatalogWritesAndTypes(t *testing.T) {
	db, f := newFake(t, map[string]answer{
		"oracle:maintained": {cols: []string{"n"}, rows: [][]driver.Value{row(int64(1))}},
		"writes:tables":     {cols: []string{"o", "t"}, rows: [][]driver.Value{row("TOWN", "STAGING")}},
		"writes:powers":     {cols: []string{"p"}, rows: [][]driver.Value{row("CREATE TABLE")}},
		"catalog:tables": {cols: []string{"o", "n", "k", "r"}, rows: [][]driver.Value{
			row("PERMITS", "PERMITS", "table", int64(812331)), row("PERMITS", "V_OPEN", "view", nil),
		}},
		"catalog:columns": {cols: []string{"o", "t", "c", "type", "len", "clen", "prec", "scale", "null"}, rows: [][]driver.Value{
			row("PERMITS", "PERMITS", "PERMIT_NUMBER", "VARCHAR2", int64(80), int64(20), nil, nil, "N"),
			row("PERMITS", "PERMITS", "FEE", "NUMBER", int64(22), int64(0), int64(10), int64(2), "Y"),
			row("PERMITS", "PERMITS", "SEQ", "NUMBER", int64(22), int64(0), int64(10), int64(0), "N"),
			row("PERMITS", "PERMITS", "ISSUED", "DATE", int64(7), int64(0), nil, nil, "Y"),
		}},
		"catalog:keys": {cols: []string{"o", "t", "c", "p"}, rows: [][]driver.Value{row("PERMITS", "PERMITS", "PERMIT_NUMBER", int64(1))}},
	})
	ora := Oracle{}
	writes, err := ora.Writes(ctx, db, "PERMITSPDB")
	if err != nil {
		t.Fatal(err)
	}
	cat, err := ora.Catalog(ctx, db, "PERMITSPDB", 10, writes)
	if err != nil {
		t.Fatal(err)
	}
	p := find(cat, "PERMITS", "PERMITS")
	types := []string{}
	for _, c := range p.Columns {
		types = append(types, c.Type)
	}
	if !reflect.DeepEqual(types, []string{"VARCHAR2(20)", "NUMBER(10,2)", "NUMBER(10)", "DATE"}) || p.Columns[0].Key != 1 || p.Writable {
		t.Fatalf("permits %+v %v", p, types)
	}
	check := WriteCheck(writes, 20)
	if !check.CanWrite || check.WritableCount != 1 || check.Powers[0] != "CREATE TABLE" {
		t.Fatalf("check %+v", check)
	}
	// Oracle's own schemas stay out of the write check as out of the catalog: every login may write
	// some of SYS's tables through PUBLIC. A database that marks its own schemas has them left out
	// by that mark too, and an 11g by the list alone.
	for _, tag := range []string{"writes:tables", "catalog:tables", "catalog:keys"} {
		if said := f.said[tag]; !strings.Contains(said, "'SYS','SYSTEM'") || !strings.Contains(said, "ORACLE_MAINTAINED = 'Y'") {
			t.Fatalf("%s leaves Oracle's own schemas in: %s", tag, said)
		}
	}
	if !strings.Contains(oracleNotOwn("OWNER", false), "'SYS','SYSTEM'") || strings.Contains(oracleNotOwn("OWNER", false), "ORACLE_MAINTAINED") {
		t.Fatal("an 11g's filter")
	}
}

// A directory object is how an Oracle database reaches its host's files. A login that may WRITE to
// one, or EXECUTE in one, is no login that can only read, though it may write no table. READ
// changes nothing and is not asked for.
func TestOracleCountsTheDirectoriesALoginMayWriteTo(t *testing.T) {
	db, f := newFake(t, map[string]answer{
		"oracle:maintained": {cols: []string{"n"}, rows: [][]driver.Value{row(int64(1))}},
		"writes:tables":     {cols: []string{"o", "t"}},
		"writes:powers": {cols: []string{"p"}, rows: [][]driver.Value{
			row("CREATE ANY DIRECTORY"), row("EXECUTE ON DIRECTORY TOOLS"), row("WRITE ON DIRECTORY EXPORTS"),
		}},
	})
	writes, err := Oracle{}.Writes(ctx, db, "PERMITSPDB")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"CREATE ANY DIRECTORY", "EXECUTE ON DIRECTORY TOOLS", "WRITE ON DIRECTORY EXPORTS"}
	if !reflect.DeepEqual(writes.Powers, want) {
		t.Fatalf("powers %v", writes.Powers)
	}
	if check := WriteCheck(writes, 20); !check.CanWrite || check.WritableCount != 0 {
		t.Fatalf("check %+v", check)
	}
	said := f.said["writes:powers"]
	for _, part := range []string{
		"'CREATE ANY DIRECTORY'",
		"PRIVILEGE || ' ON DIRECTORY ' || TABLE_NAME FROM ALL_TAB_PRIVS",
		"PRIVILEGE IN ('WRITE', 'EXECUTE')",
		"TABLE_SCHEMA = 'SYS'",
		"TABLE_NAME IN (SELECT DIRECTORY_NAME FROM ALL_DIRECTORIES)",
		"GRANTEE = USER OR GRANTEE = 'PUBLIC' OR GRANTEE IN (SELECT ROLE FROM SESSION_ROLES)",
	} {
		if !strings.Contains(said, part) {
			t.Fatalf("the powers are read without %q: %s", part, said)
		}
	}
	if strings.Contains(said, "'READ'") {
		t.Fatalf("a right to read a directory is counted as a right to change something: %s", said)
	}
}

func TestOracleEncryptionFromBannersAndClassify(t *testing.T) {
	db, _ := newFake(t, map[string]answer{
		"encryption:banners": {cols: []string{"b"}, rows: [][]driver.Value{
			row("TCP/IP NT Protocol Adapter for Linux: Version 19.0.0.0.0 - Production"),
			row("AES256 Encryption service adapter for Linux: Version 19.0.0.0.0 - Production"),
		}},
	})
	spec := Spec{Job: job.Job{TLS: job.TLS{Mode: "off"}}, Capture: &secure.Capture{}}
	enc := Oracle{}.Encryption(ctx, db, spec)
	if enc.Kind != "oracle" || enc.Version == nil || *enc.Version != "AES256" {
		t.Fatalf("encryption %+v", enc)
	}
	noRights, _ := newFake(t, map[string]answer{"encryption:banners": {err: errors.New("ORA-00942: table or view does not exist")}})
	if e := (Oracle{}).Encryption(ctx, noRights, spec); e.Kind != "none" {
		t.Fatalf("no rights reads as %+v", e)
	}
	for text, want := range map[string]string{
		"ORA-01017: invalid username/password; logon denied":         "login",
		"ORA-12514: TNS:listener does not currently know of service": "database",
		"ORA-00942: table or view does not exist":                    "database",
		"dial tcp: connection refused":                               "",
	} {
		code, _, _ := Oracle{}.Classify(errors.New(text))
		if code != want {
			t.Errorf("%q: %q, want %q", text, code, want)
		}
	}
}

func TestOracleDefinitionChangedIsTheDriversCode(t *testing.T) {
	oracleError := func(code int, message string) error {
		e := network.NewOracleError(code)
		e.ErrMsg = message
		return e
	}
	for _, c := range []struct {
		err  error
		want bool
	}{
		{oracleError(1466, "ORA-01466: unable to read data - table definition has changed"), true},
		{fmt.Errorf("query: %w", oracleError(1466, "ORA-01466: unable to read data - table definition has changed")), true},
		{errors.New("ORA-01466: unable to read data - table definition has changed"), true},
		{oracleError(942, "ORA-00942: table or view does not exist"), false},
		// A message that quotes the statement is not the code.
		{oracleError(904, `ORA-00904: "ORA-01466": invalid identifier`), false},
		{errors.New(`ORA-00904: "ORA-01466": invalid identifier`), false},
		{nil, false},
	} {
		if got := OracleDefinitionChanged(c.err); got != c.want {
			t.Errorf("%v: %t, want %t", c.err, got, c.want)
		}
	}
}

// ─── shared ────────────────────────────────────────────────────────────────

func TestClassifyCommon(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{&reach.RedirectError{Addr: "worker.example.internal:11003"}, "unreachable"},
		{fmt.Errorf("x: %w", context.DeadlineExceeded), "deadline"},
		{errors.New("tls: failed to verify certificate: x509: certificate signed by unknown authority"), "tls"},
		{fmt.Errorf("read: %w", io.EOF), "unreachable"},
		{errors.New("dial tcp 127.0.0.1:1: connect: connection refused"), "unreachable"},
		{errors.New("something else"), ""},
		// A handshake that ran out of time is the server not answering. go-mssqldb keeps only the
		// text of the error that timed out.
		{errors.New("TLS Handshake failed: read tcp 192.0.2.10:50123->192.0.2.5:1433: i/o timeout"), "unreachable"},
		{fmt.Errorf("TLS Handshake failed: %w", os.ErrDeadlineExceeded), "unreachable"},
		// A driver that keeps the error and adds words after it: the error itself says it timed out.
		{fmt.Errorf("tls: the handshake did not finish: %w, after one try", os.ErrDeadlineExceeded), "unreachable"},
		// A handshake the server refused, or one whose versions do not meet, is still TLS's.
		{errors.New("TLS Handshake failed: remote error: tls: handshake failure"), "tls"},
		{errors.New("TLS Handshake failed: tls: server selected unsupported protocol version 301"), "tls"},
		// A connect of the pool that failed is read as the error it holds.
		{&ConnectError{Err: fmt.Errorf("read: %w", io.EOF)}, "unreachable"},
		{&ConnectError{Err: fmt.Errorf("x: %w", context.DeadlineExceeded)}, "deadline"},
	}
	for _, c := range cases {
		code, _, _ := ClassifyCommon(c.err)
		if code != c.want {
			t.Errorf("%v: %q, want %q", c.err, code, c.want)
		}
	}
	words := "The server's certificate is signed by \"Test Cloud SQL Server CA\", an authority this connection does not trust."
	if code, msg, ok := ClassifyCommon(fmt.Errorf("tls error: %w", &secure.Refusal{Words: words})); !ok || code != "tls" || msg != words {
		t.Errorf("a refusal: %s %q", code, msg)
	}
	code, msg, _ := ClassifyCommon(&reach.RedirectError{Addr: "w:1"})
	if code != "unreachable" || !strings.Contains(msg, "sent the connection on to w:1.") || strings.Contains(msg, "tunnel") {
		t.Errorf("a redirect says %q", msg)
	}
}

func TestWriteCheckNamesAtMostTheLimit(t *testing.T) {
	tables := map[string]bool{}
	for i := 0; i < 30; i++ {
		tables[fmt.Sprintf("dbo.t%02d", i)] = true
	}
	c := WriteCheck(WriteSet{Tables: tables, Powers: []string{}}, 20)
	if c.WritableCount != 30 || len(c.WritableTables) != 20 || c.WritableTables[0] != "dbo.t00" {
		t.Fatalf("check %+v", c)
	}
	none := WriteCheck(WriteSet{Tables: map[string]bool{}, Powers: []string{}}, 20)
	if none.CanWrite || none.WritableTables == nil || none.Powers == nil {
		t.Fatalf("an empty check %+v must encode empty lists, not nulls", none)
	}
}

func TestForKnowsTheFourEngines(t *testing.T) {
	for _, name := range job.Engines {
		if _, err := For(name); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := For("db2"); err == nil {
		t.Error("db2 has an engine")
	}
}

// The database sees a session under the name its caller gave, or the default. SQL Server's is set
// in its connection settings, the one engine whose driver takes it there.
func TestTheSessionsNameIsItsCallersOrTheDefault(t *testing.T) {
	if got := (Spec{}).appName(); got != DefaultAppName {
		t.Fatalf("with no name: %q", got)
	}
	j := job.Job{Engine: "sqlserver", Database: "Permits", Server: job.HostPort{Host: "sql-01.example.internal", Port: 1433}, TLS: job.TLS{Mode: "verify", MinVersion: "1.2"}}
	for _, name := range []string{"", "a caller's own name"} {
		cfg, err := msConfig(Spec{Job: j, Capture: &secure.Capture{}, AppName: name})
		want := name
		if want == "" {
			want = DefaultAppName
		}
		if err != nil || cfg.AppName != want {
			t.Fatalf("SQL Server's app name %q, want %q (%v)", cfg.AppName, want, err)
		}
	}
}
