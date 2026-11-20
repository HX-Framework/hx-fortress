package run

// A query job against a scripted driver. When Oracle refuses the read because a table it reads
// changed moments before (ORA-01466), the job ends that transaction and runs the statement once
// more, QueryRetryWait later, in a new read-only transaction. Nothing else is tried again.

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sijms/go-ora/v2/network"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
)

// script is a database whose statements answer, in turn, the errors it was given. A nil answer,
// and every statement past the last answer, reads one row. Asked which character set it reads a
// statement in, it answers charset, or fails with charsetErr.
type script struct {
	mu         sync.Mutex
	answers    []error
	charset    string
	charsetErr error
	// rows, when set, is what the job's statement reads: one row each, in place of one row of 1.
	rows    []string
	queries int
	// asked counts the questions about the character set, which are no statement of the job's.
	asked    int
	begun    int
	readOnly int
	ended    int
	// events is what reached the database, in order: "begin" and "end" of a transaction, "ask" for
	// a question about the character set, "query" for the job's statement. One that came on another
	// connection than the open transaction's, or with no transaction open, ends in "-outside".
	events []string
	// conns counts the connections opened, and txConn is the open transaction's: 0 with none open.
	conns  int
	txConn int
}

// on is an event's name for a statement that came on the connection conn.
func (s *script) on(event string, conn int) string {
	if conn != s.txConn {
		return event + "-outside"
	}
	return event
}

// did is the script's events as one line.
func (s *script) did() string { return strings.Join(s.events, " ") }

var (
	scriptsMu sync.Mutex
	scripts   = map[string]*script{}
)

type scriptDriver struct{}

func init() { sql.Register("script", scriptDriver{}) }

func (scriptDriver) Open(name string) (driver.Conn, error) {
	scriptsMu.Lock()
	defer scriptsMu.Unlock()
	s, ok := scripts[name]
	if !ok {
		return nil, errors.New("no script " + name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conns++
	return scriptConn{s, s.conns}, nil
}

type scriptConn struct {
	s  *script
	id int
}

func (c scriptConn) Prepare(query string) (driver.Stmt, error) {
	return scriptStmt{c.s, query, c.id}, nil
}
func (c scriptConn) Close() error { return nil }
func (c scriptConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c scriptConn) BeginTx(_ context.Context, opts driver.TxOptions) (driver.Tx, error) {
	c.s.mu.Lock()
	defer c.s.mu.Unlock()
	c.s.begun++
	c.s.txConn = c.id
	c.s.events = append(c.s.events, "begin")
	if opts.ReadOnly {
		c.s.readOnly++
	}
	return scriptTx{c.s}, nil
}

type scriptTx struct{ s *script }

func (t scriptTx) Commit() error { return t.Rollback() }
func (t scriptTx) Rollback() error {
	t.s.mu.Lock()
	defer t.s.mu.Unlock()
	t.s.ended++
	t.s.txConn = 0
	t.s.events = append(t.s.events, "end")
	return nil
}

type scriptStmt struct {
	s     *script
	query string
	conn  int
}

func (st scriptStmt) Close() error  { return nil }
func (st scriptStmt) NumInput() int { return -1 }

// Exec takes the one statement a query job sends that is not its query: Oracle's read-only start.
func (st scriptStmt) Exec([]driver.Value) (driver.Result, error) {
	if st.query != "SET TRANSACTION READ ONLY" {
		return nil, errors.New("a query job writes nothing: " + st.query)
	}
	st.s.mu.Lock()
	defer st.s.mu.Unlock()
	st.s.readOnly++
	return driver.RowsAffected(0), nil
}

func (st scriptStmt) Query([]driver.Value) (driver.Rows, error) {
	st.s.mu.Lock()
	defer st.s.mu.Unlock()
	if strings.Contains(st.query, "/* charset:") {
		st.s.asked++
		st.s.events = append(st.s.events, st.s.on("ask", st.conn))
		if st.s.charsetErr != nil {
			return nil, st.s.charsetErr
		}
		return &scriptRows{value: st.s.charset}, nil
	}
	st.s.queries++
	st.s.events = append(st.s.events, st.s.on("query", st.conn))
	if n := st.s.queries; n <= len(st.s.answers) && st.s.answers[n-1] != nil {
		return nil, st.s.answers[n-1]
	}
	if st.s.rows != nil {
		return &scriptRows{values: st.s.rows}, nil
	}
	return &scriptRows{values: []string{"1"}}, nil
}

// scriptRows reads values, one row each, then the end.
type scriptRows struct {
	value  string
	values []string
	read   int
}

func (r *scriptRows) Columns() []string { return []string{"ID"} }
func (r *scriptRows) Close() error      { return nil }
func (r *scriptRows) Next(dest []driver.Value) error {
	values := r.values
	if values == nil {
		values = []string{r.value}
	}
	if r.read >= len(values) {
		return io.EOF
	}
	dest[0] = values[r.read]
	r.read++
	return nil
}

// scriptedOracle is Oracle's engine on a script: its own words for an error, no connection.
type scriptedOracle struct {
	engine.Oracle
	name string
}

func (o scriptedOracle) Open(context.Context, engine.Spec) (*sql.DB, error) {
	return sql.Open("script", o.name)
}

// queried is what a query job on a script did.
type queried struct {
	out    job.Output
	script *script
	slept  []time.Duration
	log    string
}

// runQuery runs a query job of engineName on a script with answers. A job whose sleep fails with
// sleepErr is one whose time ends while it waits.
func runQuery(t *testing.T, engineName string, sleepErr error, answers ...error) queried {
	t.Helper()
	return runStatement(t, engineName, "SELECT ID FROM TOWN.PERMITS", &script{answers: answers}, sleepErr)
}

// runStatement runs a query job of engineName with the statement, on the script.
func runStatement(t *testing.T, engineName, statement string, s *script, sleepErr error) queried {
	t.Helper()
	q := queried{script: s}
	scriptsMu.Lock()
	scripts[t.Name()] = q.script
	scriptsMu.Unlock()
	f := &fakes{engine: &fakeEngine{}}
	d := f.deps()
	d.Engine = func(string) (engine.Engine, error) { return scriptedOracle{name: t.Name()}, nil }
	d.Sleep = func(ctx context.Context, wait time.Duration) error {
		q.slept = append(q.slept, wait)
		if sleepErr != nil {
			return sleepErr
		}
		return f.clock.sleep(ctx, wait)
	}
	j := directJob()
	j.Kind, j.Engine = "query", engineName
	j.Params = map[string]any{"sql": statement, "limit": float64(50)}
	q.out = Run(context.Background(), j, d)
	q.log = f.log.String()
	return q
}

// oracleError is an error as go-ora hands one back from the server.
func oracleError(code int, message string) error {
	e := network.NewOracleError(code)
	e.ErrMsg = message
	return e
}

func tableChanged() error {
	return oracleError(1466, "ORA-01466: unable to read data - table definition has changed")
}

func TestAQueryOracleRefusedForAChangedTableRunsOnceMore(t *testing.T) {
	q := runQuery(t, "oracle", nil, tableChanged())
	if !q.out.OK {
		t.Fatalf("the query failed: %+v", q.out.Error)
	}
	if rows := q.out.Result.(*job.QueryResult).Rows; len(rows) != 1 || rows[0][0] == nil || *rows[0][0] != "1" {
		t.Fatalf("rows %+v", rows)
	}
	// The statement ran twice, each time in a transaction of its own that began read-only and ended.
	s := q.script
	if s.queries != 2 || s.begun != 2 || s.readOnly != 2 || s.ended != 2 {
		t.Fatalf("%d statements in %d transactions, %d read-only, %d ended", s.queries, s.begun, s.readOnly, s.ended)
	}
	if len(q.slept) != 1 || q.slept[0] != QueryRetryWait {
		t.Fatalf("waited %v, want one wait of %s", q.slept, QueryRetryWait)
	}
	if !strings.Contains(q.log, "ORA-01466") {
		t.Fatalf("the log does not say why it tried again: %s", q.log)
	}
}

func TestAQueryOracleRefusesTwiceSaysSo(t *testing.T) {
	q := runQuery(t, "oracle", nil, tableChanged(), tableChanged())
	if q.out.OK || q.out.Error.Code != "database" {
		t.Fatalf("output %+v", q.out)
	}
	if m := q.out.Error.Message; !strings.Contains(m, "again "+QueryRetryWait.String()+" after Oracle refused it") || !strings.Contains(m, "ORA-01466") {
		t.Fatalf("message %q", m)
	}
	if q.script.queries != 2 || len(q.slept) != 1 {
		t.Fatalf("%d statements, waited %v: once more, no more", q.script.queries, q.slept)
	}
}

func TestNothingElseIsTriedAgain(t *testing.T) {
	t.Run("another Oracle error", func(t *testing.T) {
		q := runQuery(t, "oracle", nil, oracleError(942, "ORA-00942: table or view does not exist"))
		if q.out.OK || q.out.Error.Code != "database" || q.script.queries != 1 || len(q.slept) != 0 {
			t.Fatalf("output %+v after %d statements, waited %v", q.out.Error, q.script.queries, q.slept)
		}
	})
	t.Run("another engine", func(t *testing.T) {
		// Only an Oracle job tries again, whatever its driver says.
		q := runQuery(t, "postgres", nil, tableChanged())
		if q.out.OK || q.script.queries != 1 || len(q.slept) != 0 || q.script.readOnly != 1 {
			t.Fatalf("output %+v after %d statements, waited %v", q.out.Error, q.script.queries, q.slept)
		}
	})
	t.Run("the job's time ends while it waits", func(t *testing.T) {
		q := runQuery(t, "oracle", context.DeadlineExceeded, tableChanged())
		if q.out.OK || q.out.Error.Code != "deadline" || q.script.queries != 1 {
			t.Fatalf("output %+v after %d statements", q.out.Error, q.script.queries)
		}
	})
}

// A statement that passes the check of its text and holds a character outside ASCII in a string.
const accentedQuery = "SELECT ID FROM TOWN.PERMITS WHERE APPLICANT = 'Zo\u00eb'"

// The check of a statement reads its text as it is written. A statement with a character outside
// ASCII runs only where the database reads that character as written too: on Oracle and MySQL the
// job asks first, and when the answer is not Unicode the statement is never sent. It asks in the
// transaction the statement runs in, so the session that answers is the one that runs it.
func TestAQueryWithACharacterOutsideASCIIRunsOnlyWhereItIsReadAsWritten(t *testing.T) {
	cases := []struct {
		engineName, charset string
		runs                bool
		did                 string
	}{
		{"oracle", "AL32UTF8", true, "begin ask query end"},
		{"oracle", "WE8MSWIN1252", false, "begin ask end"},
		{"mysql", "utf8mb4", true, "begin ask query end"},
		{"mysql", "gbk", false, "begin ask end"},
		// SQL Server and PostgreSQL read every character as written: nothing to ask.
		{"sqlserver", "", true, "begin query end"},
		{"postgres", "", true, "begin query end"},
	}
	for _, c := range cases {
		t.Run(c.engineName+" "+c.charset, func(t *testing.T) {
			q := runStatement(t, c.engineName, accentedQuery, &script{charset: c.charset}, nil)
			s := q.script
			if s.did() != c.did {
				t.Fatalf("the database saw %q, want %q", s.did(), c.did)
			}
			if c.runs {
				if !q.out.OK || s.queries != 1 {
					t.Fatalf("output %+v after %d statements", q.out.Error, s.queries)
				}
				return
			}
			if q.out.OK || q.out.Error.Code != "database" {
				t.Fatalf("output %+v", q.out)
			}
			if m := q.out.Error.Message; !strings.Contains(m, c.charset) || !strings.Contains(m, "holds only ASCII characters") {
				t.Fatalf("message %q", m)
			}
			// The statement never reached the database.
			if s.queries != 0 {
				t.Fatalf("%d statements reached the database", s.queries)
			}
			if !strings.Contains(q.log, "a character outside ASCII") {
				t.Fatalf("the log does not say why the query did not run: %s", q.log)
			}
		})
	}
}

// A statement Oracle refused for a changed table runs once more in a new transaction, and a new
// transaction may be another session: the question is asked again there.
func TestAQueryThatRunsAgainAsksItsCharacterSetAgain(t *testing.T) {
	q := runStatement(t, "oracle", accentedQuery, &script{charset: "AL32UTF8", answers: []error{tableChanged()}}, nil)
	if !q.out.OK {
		t.Fatalf("the query failed: %+v", q.out.Error)
	}
	if did, want := q.script.did(), "begin ask query end begin ask query end"; did != want {
		t.Fatalf("the database saw %q, want %q", did, want)
	}
}

// A statement of ASCII characters alone is read as written everywhere, so it costs no question.
func TestAQueryOfASCIIAloneAsksNoCharacterSet(t *testing.T) {
	for _, engineName := range []string{"oracle", "mysql"} {
		t.Run(engineName, func(t *testing.T) {
			q := runStatement(t, engineName, "SELECT ID FROM TOWN.PERMITS WHERE APPLICANT = 'Zoe'", &script{charset: "WE8MSWIN1252"}, nil)
			if !q.out.OK || q.script.asked != 0 || q.script.queries != 1 {
				t.Fatalf("output %+v, asked %d times, %d statements", q.out.Error, q.script.asked, q.script.queries)
			}
		})
	}
}

// When the database cannot say which character set it reads, nothing is known, and the statement
// is not sent.
func TestAQueryDoesNotRunWhenItsCharacterSetCannotBeAsked(t *testing.T) {
	q := runStatement(t, "oracle", accentedQuery, &script{charsetErr: oracleError(942, "ORA-00942: table or view does not exist")}, nil)
	if q.out.OK || q.out.Error.Code != "database" || q.script.did() != "begin ask end" {
		t.Fatalf("output %+v after %q", q.out.Error, q.script.did())
	}
	if m := q.out.Error.Message; !strings.Contains(m, "ask which character set the database reads a query in") || !strings.Contains(m, "ORA-00942") {
		t.Fatalf("message %q", m)
	}
}
