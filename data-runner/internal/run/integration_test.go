package run

// Real servers, one per engine, each skipped unless its admin connection is given:
//
//	DATA_RUNNER_IT_POSTGRES  postgres://user:pass@host:5432/postgres  (or a socket: postgres:///postgres?host=/var/run/postgresql)
//	DATA_RUNNER_IT_MYSQL     user:pass@tcp(host:3306)/
//	DATA_RUNNER_IT_MSSQL     sqlserver://sa:pass@host:1433?encrypt=true&TrustServerCertificate=true
//	DATA_RUNNER_IT_ORACLE    oracle://system:pass@host:1521/FREEPDB1
//
// Each test makes its own database (or schema) with tables, a read-only login and a login that may
// write one table, runs a real test job through Run with each login, and drops what it made. CI's
// data-runner job runs all four in service containers; a developer runs the Postgres one against
// a local server. The host each job dials comes from the admin connection. A job's TLS mode is
// `require` unless DATA_RUNNER_IT_<ENGINE>_TLS names another (CI's stock Postgres has no TLS).

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "github.com/microsoft/go-mssqldb"
	_ "github.com/sijms/go-ora/v2"

	"hx-fortress/data-runner/internal/job"
)

func randomName(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// itPassword is good enough for SQL Server's policy: upper, lower, digit and symbol.
func itPassword() string { return "Dr-" + randomName("Pw9") + "x!" }

// ready waits for a server that is still starting, up to four minutes.
func ready(t *testing.T, db *sql.DB) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Minute)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := db.PingContext(ctx)
		cancel()
		if err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server never answered: %v", err)
		}
		time.Sleep(3 * time.Second)
	}
}

// tlsFor is the TLS mode a job of engine uses here.
func tlsFor(engineName string) string {
	if mode := os.Getenv("DATA_RUNNER_IT_" + strings.ToUpper(engineName) + "_TLS"); mode != "" {
		return mode
	}
	if engineName == "oracle" {
		return "off"
	}
	return "require"
}

func exec(t *testing.T, db *sql.DB, statements ...string) {
	t.Helper()
	for _, s := range statements {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
}

// itDeps are the runner's real pieces for a job straight to its server, as a job a customer's
// HX Fortress starts is. They hold no way through Access, so no job here can ask Cloudflare where it
// runs or start a tunnel client.
func itDeps() Deps {
	return Production(nil)
}

// itJob is a test job straight to host:port as user.
func itJob(engineName, database, host string, port int, user, password, tlsMode string) job.Job {
	return job.Job{
		V: 1, ID: randomName("dj_it_"), Kind: "test", Engine: engineName, Database: database,
		Server:   job.HostPort{Host: host, Port: port},
		TLS:      job.TLS{Mode: tlsMode, MinVersion: "1.2"},
		Reach:    job.Reach{Kind: "direct", Host: host, Port: port},
		Login:    job.Login{Kind: "read", User: user, Password: password},
		Deadline: time.Now().Add(2 * time.Minute).Format(time.RFC3339Nano),
	}
}

func mustOK(t *testing.T, out job.Output) *job.TestResult {
	t.Helper()
	if !out.OK {
		t.Fatalf("the job failed: %+v", out.Error)
	}
	return out.Result.(*job.TestResult)
}

func tableOf(c job.Catalog, schema, name string) (job.Table, bool) {
	for _, tb := range c.Tables {
		if strings.EqualFold(tb.Schema, schema) && strings.EqualFold(tb.Name, name) {
			return tb, true
		}
	}
	return job.Table{}, false
}

// keys is a table's primary key, column by column, in key order.
func keys(tb job.Table) []string {
	out := make([]string, 8)
	n := 0
	for _, c := range tb.Columns {
		if c.Key > 0 && c.Key <= len(out) {
			out[c.Key-1] = strings.ToLower(c.Name)
			if c.Key > n {
				n = c.Key
			}
		}
	}
	return out[:n]
}

func hostPort(t *testing.T, host string, port string, fallback int) (string, int) {
	t.Helper()
	if host == "" || strings.HasPrefix(host, "/") {
		host = "127.0.0.1"
	}
	p := fallback
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil {
			t.Fatal(err)
		}
		p = n
	}
	return host, p
}

func TestPostgresForReal(t *testing.T) {
	admin := os.Getenv("DATA_RUNNER_IT_POSTGRES")
	if admin == "" {
		t.Skip("DATA_RUNNER_IT_POSTGRES is not set")
	}
	u, err := url.Parse(admin)
	if err != nil {
		t.Fatal(err)
	}
	host, port := hostPort(t, u.Hostname(), u.Port(), 5432)
	root, err := sql.Open("pgx", admin)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ready(t, root)
	name := randomName("dr_it_")
	readPW, writePW, columnPW := itPassword(), itPassword(), itPassword()
	exec(t, root, "CREATE DATABASE "+name,
		"CREATE ROLE "+name+"_r LOGIN PASSWORD '"+readPW+"'",
		"CREATE ROLE "+name+"_w LOGIN PASSWORD '"+writePW+"'",
		"CREATE ROLE "+name+"_c LOGIN PASSWORD '"+columnPW+"'")
	defer exec(t, root, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)", "DROP ROLE IF EXISTS "+name+"_r", "DROP ROLE IF EXISTS "+name+"_w", "DROP ROLE IF EXISTS "+name+"_c")
	u.Path = "/" + name
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec(t, db,
		"REVOKE ALL ON SCHEMA public FROM PUBLIC",
		"CREATE TABLE permits (town_id integer NOT NULL, permit_number text NOT NULL, issued_on date, fee numeric(10,2), PRIMARY KEY (town_id, permit_number))",
		"CREATE TABLE fees (fee_id serial PRIMARY KEY, amount numeric(10,2) NOT NULL)",
		"CREATE VIEW issued AS SELECT permit_number FROM permits WHERE issued_on IS NOT NULL",
		"INSERT INTO permits SELECT 1, 'BP-' || g, date '2026-01-01' + g, 100 FROM generate_series(1, 50) g",
		"ANALYZE",
		"GRANT USAGE ON SCHEMA public TO "+name+"_r, "+name+"_w, "+name+"_c",
		"GRANT SELECT ON ALL TABLES IN SCHEMA public TO "+name+"_r, "+name+"_w, "+name+"_c",
		"GRANT INSERT ON fees TO "+name+"_w",
		// A grant on one column only: the login can change permits, though not the whole table.
		"GRANT UPDATE (issued_on) ON permits TO "+name+"_c")

	read := mustOK(t, Run(context.Background(), itJob("postgres", name, host, port, name+"_r", readPW, tlsFor("postgres")), itDeps()))
	if read.Write.CanWrite {
		t.Fatalf("the read login can write: %+v", read.Write)
	}
	permits, ok := tableOf(read.Catalog, "public", "permits")
	if !ok || strings.Join(keys(permits), ",") != "town_id,permit_number" || permits.Rows == nil || *permits.Rows != 50 {
		t.Fatalf("permits %+v", permits)
	}
	if v, ok := tableOf(read.Catalog, "public", "issued"); !ok || v.Kind != "view" {
		t.Fatalf("the view %+v", v)
	}
	if read.Encryption.Kind != "tls" {
		t.Logf("the server speaks no TLS: %+v", read.Encryption)
	}

	write := mustOK(t, Run(context.Background(), itJob("postgres", name, host, port, name+"_w", writePW, tlsFor("postgres")), itDeps()))
	if !write.Write.CanWrite || write.Write.WritableCount != 1 || write.Write.WritableTables[0] != "public.fees" {
		t.Fatalf("the write login: %+v", write.Write)
	}
	column := mustOK(t, Run(context.Background(), itJob("postgres", name, host, port, name+"_c", columnPW, tlsFor("postgres")), itDeps()))
	if !column.Write.CanWrite || column.Write.WritableCount != 1 || column.Write.WritableTables[0] != "public.permits" {
		t.Fatalf("the login with a column's grant: %+v", column.Write)
	}
	bad := Run(context.Background(), itJob("postgres", name, host, port, name+"_r", "wrong", tlsFor("postgres")), itDeps())
	if bad.OK || bad.Error.Code != "login" {
		t.Fatalf("a wrong password: %+v", bad.Error)
	}
}

func TestMySQLForReal(t *testing.T) {
	admin := os.Getenv("DATA_RUNNER_IT_MYSQL")
	if admin == "" {
		t.Skip("DATA_RUNNER_IT_MYSQL is not set")
	}
	root, err := sql.Open("mysql", admin)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ready(t, root)
	host, port := "127.0.0.1", 3306
	if i := strings.Index(admin, "tcp("); i >= 0 {
		addr := admin[i+4 : strings.Index(admin[i:], ")")+i]
		h, p, _ := strings.Cut(addr, ":")
		host, port = hostPort(t, h, p, 3306)
	}
	name := randomName("dr_it_")
	readPW, writePW := itPassword(), itPassword()
	exec(t, root, "CREATE DATABASE "+name,
		"CREATE TABLE "+name+".permits (town_id INT NOT NULL, permit_number VARCHAR(40) NOT NULL, issued_on DATE, PRIMARY KEY (town_id, permit_number))",
		"CREATE TABLE "+name+".fees (fee_id INT AUTO_INCREMENT PRIMARY KEY, amount DECIMAL(10,2) NOT NULL)",
		"CREATE VIEW "+name+".issued AS SELECT permit_number FROM "+name+".permits",
		"CREATE USER '"+name+"_r'@'%' IDENTIFIED BY '"+readPW+"'",
		"CREATE USER '"+name+"_w'@'%' IDENTIFIED BY '"+writePW+"'",
		"GRANT SELECT ON "+name+".* TO '"+name+"_r'@'%'",
		"GRANT SELECT ON "+name+".* TO '"+name+"_w'@'%'",
		"GRANT INSERT ON "+name+".fees TO '"+name+"_w'@'%'")
	defer exec(t, root, "DROP DATABASE IF EXISTS "+name, "DROP USER IF EXISTS '"+name+"_r'@'%'", "DROP USER IF EXISTS '"+name+"_w'@'%'")

	read := mustOK(t, Run(context.Background(), itJob("mysql", name, host, port, name+"_r", readPW, tlsFor("mysql")), itDeps()))
	if read.Write.CanWrite {
		t.Fatalf("the read login can write: %+v", read.Write)
	}
	permits, ok := tableOf(read.Catalog, name, "permits")
	if !ok || strings.Join(keys(permits), ",") != "town_id,permit_number" {
		t.Fatalf("permits %+v", permits)
	}
	write := mustOK(t, Run(context.Background(), itJob("mysql", name, host, port, name+"_w", writePW, tlsFor("mysql")), itDeps()))
	if !write.Write.CanWrite || write.Write.WritableTables[0] != name+".fees" {
		t.Fatalf("the write login: %+v", write.Write)
	}
}

func TestSQLServerForReal(t *testing.T) {
	admin := os.Getenv("DATA_RUNNER_IT_MSSQL")
	if admin == "" {
		t.Skip("DATA_RUNNER_IT_MSSQL is not set")
	}
	u, err := url.Parse(admin)
	if err != nil {
		t.Fatal(err)
	}
	host, port := hostPort(t, u.Hostname(), u.Port(), 1433)
	root, err := sql.Open("sqlserver", admin)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ready(t, root)
	name := randomName("dr_it_")
	readPW, writePW := itPassword(), itPassword()
	exec(t, root, "CREATE DATABASE "+name,
		"CREATE LOGIN "+name+"_r WITH PASSWORD = '"+readPW+"', CHECK_POLICY = OFF",
		"CREATE LOGIN "+name+"_w WITH PASSWORD = '"+writePW+"', CHECK_POLICY = OFF")
	defer exec(t, root, "ALTER DATABASE "+name+" SET SINGLE_USER WITH ROLLBACK IMMEDIATE", "DROP DATABASE "+name, "DROP LOGIN "+name+"_r", "DROP LOGIN "+name+"_w")
	q := u.Query()
	q.Set("database", name)
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlserver", u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	exec(t, db,
		"CREATE TABLE dbo.permits (town_id INT NOT NULL, permit_number NVARCHAR(40) NOT NULL, issued_on DATE NULL, fee DECIMAL(10,2) NULL, CONSTRAINT pk_permits PRIMARY KEY (town_id, permit_number))",
		"CREATE TABLE dbo.fees (fee_id INT IDENTITY PRIMARY KEY, amount DECIMAL(10,2) NOT NULL)",
		"CREATE VIEW dbo.issued AS SELECT permit_number FROM dbo.permits",
		"CREATE USER "+name+"_r FOR LOGIN "+name+"_r",
		"CREATE USER "+name+"_w FOR LOGIN "+name+"_w",
		"GRANT SELECT ON SCHEMA::dbo TO "+name+"_r",
		"GRANT SELECT ON SCHEMA::dbo TO "+name+"_w",
		"GRANT INSERT ON dbo.fees TO "+name+"_w")
	// The setup's own connection to the database goes before the jobs connect and the drop.
	_ = db.Close()

	read := mustOK(t, Run(context.Background(), itJob("sqlserver", name, host, port, name+"_r", readPW, tlsFor("sqlserver")), itDeps()))
	if read.Write.CanWrite {
		t.Fatalf("the read login can write: %+v", read.Write)
	}
	permits, ok := tableOf(read.Catalog, "dbo", "permits")
	if !ok || strings.Join(keys(permits), ",") != "town_id,permit_number" || (tlsFor("sqlserver") != "off" && read.Encryption.Kind != "tls") {
		t.Fatalf("permits %+v, encryption %+v", permits, read.Encryption)
	}
	write := mustOK(t, Run(context.Background(), itJob("sqlserver", name, host, port, name+"_w", writePW, tlsFor("sqlserver")), itDeps()))
	if !write.Write.CanWrite || write.Write.WritableTables[0] != "dbo.fees" {
		t.Fatalf("the write login: %+v", write.Write)
	}
}

func TestOracleForReal(t *testing.T) {
	admin := os.Getenv("DATA_RUNNER_IT_ORACLE")
	if admin == "" {
		t.Skip("DATA_RUNNER_IT_ORACLE is not set")
	}
	u, err := url.Parse(admin)
	if err != nil {
		t.Fatal(err)
	}
	host, port := hostPort(t, u.Hostname(), u.Port(), 1521)
	service := strings.TrimPrefix(u.Path, "/")
	root, err := sql.Open("oracle", admin)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ready(t, root)
	owner := strings.ToUpper(randomName("DR_IT_"))
	ownerPW, readPW := itPassword(), itPassword()
	exec(t, root,
		`CREATE USER `+owner+` IDENTIFIED BY "`+ownerPW+`" QUOTA UNLIMITED ON USERS`,
		`GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW TO `+owner,
		`CREATE USER `+owner+`_R IDENTIFIED BY "`+readPW+`"`,
		`GRANT CREATE SESSION TO `+owner+`_R`)
	defer exec(t, root, "DROP USER "+owner+"_R CASCADE", "DROP USER "+owner+" CASCADE")
	ou := *u
	ou.User = url.UserPassword(owner, ownerPW)
	db, err := sql.Open("oracle", ou.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec(t, db,
		"CREATE TABLE PERMITS (TOWN_ID NUMBER(10) NOT NULL, PERMIT_NUMBER VARCHAR2(40) NOT NULL, ISSUED_ON DATE, FEE NUMBER(10,2), CONSTRAINT PK_PERMITS PRIMARY KEY (TOWN_ID, PERMIT_NUMBER))",
		"CREATE TABLE FEES (FEE_ID NUMBER(10) PRIMARY KEY, AMOUNT NUMBER(10,2) NOT NULL)",
		"CREATE VIEW ISSUED AS SELECT PERMIT_NUMBER FROM PERMITS",
		"GRANT SELECT ON PERMITS TO "+owner+"_R",
		"GRANT SELECT ON ISSUED TO "+owner+"_R")

	read := mustOK(t, Run(context.Background(), itJob("oracle", service, host, port, owner+"_R", readPW, tlsFor("oracle")), itDeps()))
	if read.Write.CanWrite {
		t.Fatalf("the read login can write: %+v", read.Write)
	}
	permits, ok := tableOf(read.Catalog, owner, "PERMITS")
	if !ok || strings.Join(keys(permits), ",") != "town_id,permit_number" {
		t.Fatalf("permits %+v", permits)
	}
	if _, ok := tableOf(read.Catalog, owner, "FEES"); ok {
		t.Fatal("a table the login cannot read is in its catalog")
	}
	owned := mustOK(t, Run(context.Background(), itJob("oracle", service, host, port, owner, ownerPW, tlsFor("oracle")), itDeps()))
	if !owned.Write.CanWrite || owned.Write.WritableCount != 2 {
		t.Fatalf("the owner: %+v", owned.Write)
	}
}
