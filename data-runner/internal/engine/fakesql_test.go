package engine

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sync"
	"testing"
)

// A fake database/sql driver for the engines' tests. Each engine's query carries a tag comment
// (`/* catalog:tables */`); the fake answers by tag with the rows a test gave it, records the
// arguments, and fails the test on a tag it was not given.

type answer struct {
	cols []string
	rows [][]driver.Value
	err  error
}

type fakeDB struct {
	mu      sync.Mutex
	t       *testing.T
	answers map[string]answer
	asked   map[string][]driver.Value
	// said is the statement last sent with each tag.
	said map[string]string
}

var (
	fakesMu sync.Mutex
	fakes   = map[string]*fakeDB{}
	tagRe   = regexp.MustCompile(`/\* ([a-z]+:?[a-z]*) \*/`)
)

func init() { sql.Register("fake", fakeDriver{}) }

// newFake is a *sql.DB that answers by tag.
func newFake(t *testing.T, answers map[string]answer) (*sql.DB, *fakeDB) {
	t.Helper()
	f := &fakeDB{t: t, answers: answers, asked: map[string][]driver.Value{}, said: map[string]string{}}
	fakesMu.Lock()
	fakes[t.Name()] = f
	fakesMu.Unlock()
	db, err := sql.Open("fake", t.Name())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, f
}

type fakeDriver struct{}

func (fakeDriver) Open(name string) (driver.Conn, error) {
	fakesMu.Lock()
	defer fakesMu.Unlock()
	f, ok := fakes[name]
	if !ok {
		return nil, fmt.Errorf("no fake %q", name)
	}
	return &fakeConn{f}, nil
}

type fakeConn struct{ f *fakeDB }

func (c *fakeConn) Prepare(query string) (driver.Stmt, error) { return &fakeStmt{c.f, query}, nil }
func (c *fakeConn) Close() error                              { return nil }
func (c *fakeConn) Begin() (driver.Tx, error)                 { return nil, errors.New("the fake has no transactions") }

type fakeStmt struct {
	f     *fakeDB
	query string
}

func (s *fakeStmt) Close() error  { return nil }
func (s *fakeStmt) NumInput() int { return -1 }
func (s *fakeStmt) Exec([]driver.Value) (driver.Result, error) {
	return nil, errors.New("an engine's test never writes")
}

func (s *fakeStmt) Query(args []driver.Value) (driver.Rows, error) {
	m := tagRe.FindStringSubmatch(s.query)
	if m == nil {
		s.f.t.Errorf("a query without a tag: %s", s.query)
		return nil, errors.New("untagged query")
	}
	s.f.mu.Lock()
	s.f.asked[m[1]] = args
	s.f.said[m[1]] = s.query
	a, ok := s.f.answers[m[1]]
	s.f.mu.Unlock()
	if !ok {
		s.f.t.Errorf("no answer for %s", m[1])
		return nil, fmt.Errorf("no answer for %s", m[1])
	}
	if a.err != nil {
		return nil, a.err
	}
	return &fakeRows{cols: a.cols, rows: a.rows}, nil
}

type fakeRows struct {
	cols []string
	rows [][]driver.Value
	i    int
}

func (r *fakeRows) Columns() []string { return r.cols }
func (r *fakeRows) Close() error      { return nil }
func (r *fakeRows) Next(dest []driver.Value) error {
	if r.i >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.i])
	r.i++
	return nil
}

// row is a shorthand for one row of values.
func row(values ...driver.Value) []driver.Value { return values }

var ctx = context.Background()
