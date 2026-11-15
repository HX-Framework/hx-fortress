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
// and every statement past the last answer, reads one row.
type script struct {
	mu       sync.Mutex
	answers  []error
	queries  int
	begun    int
	readOnly int
	ended    int
}

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
	return scriptConn{s}, nil
}

type scriptConn struct{ s *script }

func (c scriptConn) Prepare(query string) (driver.Stmt, error) { return scriptStmt{c.s, query}, nil }
func (c scriptConn) Close() error                              { return nil }
func (c scriptConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c scriptConn) BeginTx(_ context.Context, opts driver.TxOptions) (driver.Tx, error) {
	c.s.mu.Lock()
	defer c.s.mu.Unlock()
	c.s.begun++
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
	return nil
}

type scriptStmt struct {
	s     *script
	query string
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
	st.s.queries++
	if n := st.s.queries; n <= len(st.s.answers) && st.s.answers[n-1] != nil {
		return nil, st.s.answers[n-1]
	}
	return &scriptRows{}, nil
}

type scriptRows struct{ read bool }

func (r *scriptRows) Columns() []string { return []string{"ID"} }
func (r *scriptRows) Close() error      { return nil }
func (r *scriptRows) Next(dest []driver.Value) error {
	if r.read {
		return io.EOF
	}
	r.read = true
	dest[0] = "1"
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
	q := queried{script: &script{answers: answers}}
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
	j.Params = map[string]any{"sql": "SELECT ID FROM TOWN.PERMITS", "limit": float64(50)}
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
