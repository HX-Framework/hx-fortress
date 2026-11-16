package run

// A pull and a query against real servers, each skipped unless its admin connection is given
// (integration_test.go lists them). Each makes a table of the engine's usual types, pulls it into a
// store that lives in this test's memory, pulls it again, and expects the second pull to send
// nothing: a value that read differently the second time would make its row look changed.

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/pull"
)

// memStore is a store's side of a pull, in memory: it keeps each table's rows by key.
type memStore struct {
	into    string
	source  pull.Source
	held    map[string][2]string // key to [hash, rowJSON]
	begun   bool
	mode    string
	sent    int
	removed []string
	failed  *pull.FailBody
}

func (s *memStore) State(context.Context) (pull.State, error) {
	return pull.State{
		State:  "taking",
		Tables: []pull.TableState{{Source: s.source, Into: s.into}},
		Limits: pull.Limits{PageRows: 500, PageBytes: 1 << 20, HashRows: 1000, RowBytes: 1 << 20, Removed: 1000},
	}, nil
}

func (s *memStore) Begin(context.Context, pull.BeginBody) (pull.BeginAnswer, error) {
	s.mode = "new"
	if s.begun {
		s.mode = "change"
	}
	s.begun = true
	return pull.BeginAnswer{Mode: s.mode}, nil
}

func (s *memStore) Hashes(context.Context, pull.HashesBody) (pull.HashesAnswer, error) {
	answer := pull.HashesAnswer{Hashes: [][2]string{}}
	for k, v := range s.held {
		answer.Hashes = append(answer.Hashes, [2]string{k, v[0]})
	}
	return answer, nil
}

func (s *memStore) Page(_ context.Context, _ int, _ int64, rowsJSON []byte, removed []string) (pull.PageAnswer, error) {
	var rows [][]*string
	if len(rowsJSON) > 0 {
		if err := json.Unmarshal(append(append([]byte{'['}, rowsJSON...), ']'), &rows); err != nil {
			return pull.PageAnswer{}, err
		}
	}
	for i, row := range rows {
		s.sent++
		var one strings.Builder
		for _, v := range row[2:] {
			if v == nil {
				one.WriteString("<null>|")
			} else {
				one.WriteString(*v + "|")
			}
		}
		_ = i
		s.held[*row[0]] = [2]string{*row[1], one.String()}
	}
	s.removed = append(s.removed, removed...)
	for _, k := range removed {
		delete(s.held, k)
	}
	return pull.PageAnswer{Taken: true}, nil
}

func (s *memStore) End(context.Context, pull.EndBody) (pull.EndAnswer, error) {
	return pull.EndAnswer{Finishing: true}, nil
}

func (s *memStore) Fail(_ context.Context, body pull.FailBody) error {
	s.failed = &body
	return nil
}

func pullDeps(store *memStore) Deps {
	d := itDeps()
	d.NewStore = func(job.Store, func(context.Context, time.Duration) error) pull.Store { return store }
	return d
}

// pullTwice pulls the table, checks the rows came, pulls again and checks nothing was sent.
func pullTwice(t *testing.T, j job.Job, source pull.Source, wantRows int) *memStore {
	t.Helper()
	store := &memStore{into: "t", source: source, held: map[string][2]string{}}
	j.Kind = "pull"
	j.Store = &job.Store{GatewayURL: "http://unused", StoreID: "sto_1", JobID: "job_1", Key: "k1.it"}
	first := Run(context.Background(), j, pullDeps(store))
	if !first.OK {
		t.Fatalf("the first pull failed: %+v (the store heard %+v)", first.Error, store.failed)
	}
	if store.sent != wantRows || len(store.held) != wantRows || store.mode != "new" {
		t.Fatalf("the first pull sent %d rows, the store holds %d, mode %s", store.sent, len(store.held), store.mode)
	}
	for k, row := range store.held {
		t.Logf("%s = %s", k, row[1])
	}
	store.sent = 0
	j.ID = randomName("dj_it_")
	second := Run(context.Background(), j, pullDeps(store))
	if !second.OK {
		t.Fatalf("the second pull failed: %+v", second.Error)
	}
	if store.sent != 0 || len(store.removed) != 0 || store.mode != "change" {
		t.Fatalf("the second pull sent %d rows and removed %v, mode %s", store.sent, store.removed, store.mode)
	}
	return store
}

// queryOne runs a query job and expects its rows.
func queryOne(t *testing.T, j job.Job, statement string, wantRows int) *job.QueryResult {
	t.Helper()
	j.Kind = "query"
	j.Params = map[string]any{"sql": statement, "limit": float64(50)}
	out := Run(context.Background(), j, itDeps())
	if !out.OK {
		t.Fatalf("the query failed: %+v", out.Error)
	}
	result := out.Result.(*job.QueryResult)
	if len(result.Rows) != wantRows {
		t.Fatalf("the query answered %d rows, want %d", len(result.Rows), wantRows)
	}
	return result
}

func TestPostgresPullForReal(t *testing.T) {
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
	name := randomName("dr_pull_")
	pw := itPassword()
	exec(t, root, "CREATE DATABASE "+name, "CREATE ROLE "+name+"_r LOGIN PASSWORD '"+pw+"'")
	defer exec(t, root, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)", "DROP ROLE IF EXISTS "+name+"_r")
	u.Path = "/" + name
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec(t, db,
		`CREATE TABLE permits (id bigint NOT NULL, part int NOT NULL, amount numeric(20,2), issued date, moment timestamptz, stamped timestamp, note text, raw bytea, ok boolean, ratio double precision, details jsonb, PRIMARY KEY (id, part))`,
		`INSERT INTO permits VALUES (9007199254740993, 1, 1234567890123456.78, '2026-03-14', '2026-03-14 12:00:00+00', '2026-03-14 12:00:00.5', 'résumé', '\xdeadbeef', true, 0.1, '{"a": 1}'),
		                            (2, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
		                            (3, 2, 0, '1999-12-31', now(), now(), '', '', false, 1e300, '[]')`,
		"CREATE TABLE heap (a text, b text)",
		"INSERT INTO heap VALUES ('x', '1'), ('x', '1'), ('y', NULL)",
		"GRANT USAGE ON SCHEMA public TO "+name+"_r",
		"GRANT SELECT ON ALL TABLES IN SCHEMA public TO "+name+"_r")
	j := itJob("postgres", name, host, port, name+"_r", pw, tlsFor("postgres"))
	store := pullTwice(t, j, pull.Source{Schema: "public", Name: "permits"}, 3)
	if _, ok := store.held[`["9007199254740993","1"]`]; !ok {
		t.Fatalf("no row named by its whole key: %v", store.held)
	}
	heap := pullTwice(t, itJob("postgres", name, host, port, name+"_r", pw, tlsFor("postgres")), pull.Source{Schema: "public", Name: "heap"}, 3)
	repeats := 0
	for k := range heap.held {
		if strings.HasSuffix(k, "#2") {
			repeats++
		}
	}
	if repeats != 1 {
		t.Fatalf("a repeated row with no key: %v", heap.held)
	}
	result := queryOne(t, itJob("postgres", name, host, port, name+"_r", pw, tlsFor("postgres")), "SELECT id, amount, note FROM permits WHERE id < 4 ORDER BY id", 2)
	if *result.Rows[0][0] != "2" || result.Rows[0][1] != nil {
		t.Fatalf("rows %+v", result.Rows)
	}
	readOnly := itJob("postgres", name, host, port, name+"_r", pw, tlsFor("postgres"))
	readOnly.Kind = "query"
	readOnly.Params = map[string]any{"sql": "WITH gone AS (DELETE FROM heap RETURNING a) SELECT * FROM gone"}
	if out := Run(context.Background(), readOnly, itDeps()); out.OK || out.Error.Code != "database" {
		t.Fatalf("a write through a query: %+v", out)
	}
	// A query at its row limit stops reading: closing the rows must not read the rest of the result.
	long := itJob("postgres", name, host, port, name+"_r", pw, tlsFor("postgres"))
	long.Kind = "query"
	long.Params = map[string]any{"sql": "SELECT generate_series(1, 2000000000)", "limit": 5}
	started := time.Now()
	if out := Run(context.Background(), long, itDeps()); !out.OK {
		t.Fatalf("a long query: %+v", out)
	}
	if took := time.Since(started); took > 30*time.Second {
		t.Fatalf("a query of 5 rows took %s: it read the rest of its result", took)
	}
}

func TestMySQLPullForReal(t *testing.T) {
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
	name := randomName("dr_pull_")
	pw := itPassword()
	exec(t, root, "CREATE DATABASE "+name,
		"CREATE TABLE "+name+".permits (id BIGINT NOT NULL PRIMARY KEY, amount DECIMAL(20,2), issued DATE, moment DATETIME(3), note TEXT, raw VARBINARY(20), ok TINYINT(1), ratio DOUBLE)",
		"INSERT INTO "+name+".permits VALUES (9007199254740993, 1234567890123456.78, '2026-03-14', '2026-03-14 12:00:00.500', 'résumé', 0xdeadbeef, 1, 0.1), (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL), (3, 0, '1999-12-31', NOW(3), '', '', 0, 1e300)",
		"CREATE USER '"+name+"_r'@'%' IDENTIFIED BY '"+pw+"'",
		"GRANT SELECT ON "+name+".* TO '"+name+"_r'@'%'")
	defer exec(t, root, "DROP DATABASE IF EXISTS "+name, "DROP USER IF EXISTS '"+name+"_r'@'%'")
	j := itJob("mysql", name, host, port, name+"_r", pw, tlsFor("mysql"))
	store := pullTwice(t, j, pull.Source{Schema: name, Name: "permits"}, 3)
	if _, ok := store.held["9007199254740993"]; !ok {
		t.Fatalf("no row named by its whole key: %v", store.held)
	}
	queryOne(t, itJob("mysql", name, host, port, name+"_r", pw, tlsFor("mysql")), "SELECT id, amount FROM permits ORDER BY id", 3)
	// A character outside ASCII: the job asks which character set the session reads a statement in
	// (the read login may), and this server's is UTF-8, so the statement runs and the character
	// comes back as it was written.
	if accented := queryOne(t, itJob("mysql", name, host, port, name+"_r", pw, tlsFor("mysql")), "SELECT 'Zo\u00eb' AS applicant", 1); *accented.Rows[0][0] != "Zo\u00eb" {
		t.Fatalf("a character outside ASCII came back as %q", *accented.Rows[0][0])
	}
}

func TestSQLServerPullForReal(t *testing.T) {
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
	name := randomName("dr_pull_")
	pw := itPassword()
	exec(t, root, "CREATE DATABASE "+name, "CREATE LOGIN "+name+"_r WITH PASSWORD = '"+pw+"', CHECK_POLICY = OFF")
	defer exec(t, root, "ALTER DATABASE "+name+" SET SINGLE_USER WITH ROLLBACK IMMEDIATE", "DROP DATABASE "+name, "DROP LOGIN "+name+"_r")
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
		"CREATE TABLE dbo.permits (id BIGINT NOT NULL PRIMARY KEY, amount DECIMAL(20,2), issued DATE, moment DATETIME2(3), zoned DATETIMEOFFSET, note NVARCHAR(100), raw VARBINARY(20), ok BIT, ref UNIQUEIDENTIFIER, ver ROWVERSION, ratio FLOAT)",
		"INSERT INTO dbo.permits (id, amount, issued, moment, zoned, note, raw, ok, ref, ratio) VALUES (9007199254740993, 1234567890123456.78, '2026-03-14', '2026-03-14 12:00:00.500', '2026-03-14 12:00:00 +02:00', N'résumé', 0xdeadbeef, 1, '12345678-1234-1234-1234-123456789abc', 0.1)",
		"INSERT INTO dbo.permits (id) VALUES (2)",
		"CREATE USER "+name+"_r FOR LOGIN "+name+"_r",
		"GRANT SELECT TO "+name+"_r")
	j := itJob("sqlserver", name, host, port, name+"_r", pw, tlsFor("sqlserver"))
	store := pullTwice(t, j, pull.Source{Schema: "dbo", Name: "permits"}, 2)
	row, ok := store.held["9007199254740993"]
	if !ok {
		t.Fatalf("no row named by its whole key: %v", store.held)
	}
	if !strings.Contains(row[1], "12345678-1234-1234-1234-123456789ABC") {
		t.Fatalf("a uniqueidentifier reads as its GUID: %s", row[1])
	}
	queryOne(t, itJob("sqlserver", name, host, port, name+"_r", pw, tlsFor("sqlserver")), "SELECT id, amount FROM dbo.permits ORDER BY id", 2)
}

func TestOraclePullForReal(t *testing.T) {
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
	owner := strings.ToUpper(randomName("DR_PULL_"))
	ownerPW, readPW := itPassword(), itPassword()
	exec(t, root,
		`CREATE USER `+owner+` IDENTIFIED BY "`+ownerPW+`" QUOTA UNLIMITED ON USERS`,
		`GRANT CREATE SESSION, CREATE TABLE TO `+owner,
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
		"CREATE TABLE PERMITS (ID NUMBER(19) NOT NULL PRIMARY KEY, AMOUNT NUMBER(20,2), ISSUED DATE, MOMENT TIMESTAMP(3), ZONED TIMESTAMP WITH TIME ZONE, NOTE VARCHAR2(100), RAWV RAW(20), MEMO CLOB, RATIO BINARY_DOUBLE)",
		"INSERT INTO PERMITS VALUES (9007199254740993, 1234567890123456.78, DATE '2026-03-14', TIMESTAMP '2026-03-14 12:00:00.500', TIMESTAMP '2026-03-14 12:00:00 +02:00', 'résumé', HEXTORAW('DEADBEEF'), 'a memo', 0.1)",
		"INSERT INTO PERMITS (ID) VALUES (2)",
		"GRANT SELECT ON PERMITS TO "+owner+"_R")
	j := itJob("oracle", service, host, port, owner+"_R", readPW, tlsFor("oracle"))
	store := pullTwice(t, j, pull.Source{Schema: owner, Name: "PERMITS"}, 2)
	row, ok := store.held["9007199254740993"]
	if !ok {
		t.Fatalf("no row named by its whole key: %v", store.held)
	}
	if !strings.Contains(row[1], "1234567890123456.78") {
		t.Fatalf("a NUMBER keeps every digit: %s", row[1])
	}
	queryOne(t, itJob("oracle", service, host, port, owner+"_R", readPW, tlsFor("oracle")), "SELECT ID, AMOUNT FROM "+owner+".PERMITS ORDER BY ID", 2)
	// A character outside ASCII: the job asks the database's character set (the read login may),
	// and this database's is AL32UTF8, so the statement runs and the character comes back as it was
	// written.
	if accented := queryOne(t, itJob("oracle", service, host, port, owner+"_R", readPW, tlsFor("oracle")), "SELECT 'Zo\u00eb' AS APPLICANT FROM DUAL", 1); *accented.Rows[0][0] != "Zo\u00eb" {
		t.Fatalf("a character outside ASCII came back as %q", *accented.Rows[0][0])
	}

	// A query job right after its table changes answers, on its second try when Oracle refused the
	// first (ORA-01466).
	exec(t, db, "CREATE TABLE FRESH (ID NUMBER(19))", "INSERT INTO FRESH VALUES (7)", "GRANT SELECT ON FRESH TO "+owner+"_R")
	fresh := itJob("oracle", service, host, port, owner+"_R", readPW, tlsFor("oracle"))
	fresh.Kind = "query"
	fresh.Params = map[string]any{"sql": "SELECT ID FROM " + owner + ".FRESH", "limit": float64(50)}
	var said strings.Builder
	d := itDeps()
	d.Log = &said
	out := Run(context.Background(), fresh, d)
	if !out.OK {
		t.Fatalf("a query right after its table was made: %+v", out.Error)
	}
	if rows := out.Result.(*job.QueryResult).Rows; len(rows) != 1 {
		t.Fatalf("a query right after its table was made answered %d rows", len(rows))
	}
	t.Logf("a query right after its table was made: %s", strings.TrimSpace(said.String()))

	// How long Oracle refuses read-only reads after a change: a query job's second try comes
	// QueryRetryWait after its first, so the refusal must end sooner.
	ru := *u
	ru.User = url.UserPassword(owner+"_R", readPW)
	reader, err := sql.Open("oracle", ru.String())
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	ready(t, reader)
	exec(t, db, "CREATE TABLE LATER (ID NUMBER(19))", "GRANT SELECT ON LATER TO "+owner+"_R")
	created := refusedFor(t, reader, owner+".LATER")
	// A table gets its storage with its first row, and a TRUNCATE of one without changes nothing.
	exec(t, db, "INSERT INTO LATER VALUES (1)")
	exec(t, db, "TRUNCATE TABLE LATER")
	truncated := refusedFor(t, reader, owner+".LATER")
	t.Logf("Oracle refused read-only reads for %s after a CREATE TABLE and %s after a TRUNCATE", created, truncated)
	if created >= QueryRetryWait || truncated >= QueryRetryWait {
		t.Fatalf("Oracle refused read-only reads longer than a query job waits before its second try (%s)", QueryRetryWait)
	}
}

// refusedFor is how long Oracle refuses a read-only read of table after the change made just
// before (ORA-01466), tried every 50 ms on db.
func refusedFor(t *testing.T, db *sql.DB, table string) time.Duration {
	t.Helper()
	changed := time.Now()
	for {
		err := readOnlyRead(db, table)
		waited := time.Since(changed)
		if err == nil || waited > 2*QueryRetryWait {
			return waited.Round(10 * time.Millisecond)
		}
		if !engine.OracleDefinitionChanged(err) {
			t.Fatalf("a read-only read of %s: %v", table, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// readOnlyRead counts table's rows in a read-only transaction, as a query job reads.
func readOnlyRead(db *sql.DB, table string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec("SET TRANSACTION READ ONLY"); err != nil {
		return err
	}
	var n int64
	return tx.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n)
}
