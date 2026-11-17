// Package engine is each database engine's part of a data job: how to open a connection with the
// engine's own driver, and the engine's own SQL for its version, its catalog and what a login may
// change. The rest of the runner never speaks an engine's dialect.
package engine

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"net"
	"sort"
	"strings"
	"time"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/reach"
	"hx-fortress/data-runner/internal/secure"
)

// Spec is everything an engine needs to open a connection.
type Spec struct {
	Job    job.Job
	Dialer *reach.Dialer
	// Capture records the TLS handshake the driver completes.
	Capture *secure.Capture
	// AppName is the application name the database sees for the session. Empty is DefaultAppName.
	AppName string
}

// DefaultAppName is the application name a session carries when its caller names none.
const DefaultAppName = "data runner"

// appName is the application name the database sees for this job's session.
func (s Spec) appName() string {
	if s.AppName != "" {
		return s.AppName
	}
	return DefaultAppName
}

// Querier is the part of *sql.DB an engine's SQL runs through, so tests can hand it a fake.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// WriteSet is what a login may change: its writable tables as "schema.table", and the powers that
// let it write beyond single tables.
type WriteSet struct {
	Tables map[string]bool
	Powers []string
}

// Engine is one engine's driver and dialect.
type Engine interface {
	// Open connects and checks the connection with one round trip.
	Open(ctx context.Context, spec Spec) (*sql.DB, error)
	// Version is the server's own version string.
	Version(ctx context.Context, q Querier) (string, error)
	// Writes is what the job's login may change.
	Writes(ctx context.Context, q Querier, database string) (WriteSet, error)
	// Catalog reads at most max tables, the first by schema and name, with their columns and keys,
	// marking the ones in writes.
	Catalog(ctx context.Context, q Querier, database string, max int, writes WriteSet) (job.Catalog, error)
	// Encryption is how the connection was encrypted, from the TLS capture and what else the
	// engine knows (Oracle's own encryption).
	Encryption(ctx context.Context, q Querier, spec Spec) job.Encryption
	// Classify turns a driver error into the contract's code and a plain sentence, or ok false
	// when the engine does not know the error.
	Classify(err error) (code, message string, ok bool)
}

// For is the engine of a job.
func For(name string) (Engine, error) {
	switch name {
	case "postgres":
		return Postgres{}, nil
	case "sqlserver":
		return SQLServer{}, nil
	case "mysql":
		return MySQL{}, nil
	case "oracle":
		return Oracle{}, nil
	}
	return nil, fmt.Errorf("no engine %q", name)
}

// ─── shared pieces ─────────────────────────────────────────────────────────

// ConnectTimeout bounds a driver's whole connect, login included. A query after it is bounded by
// the job's deadline alone.
const ConnectTimeout = 30 * time.Second

// newPool is a job's pool, made from its driver's connector. It holds one connection, so a job
// never opens a second session on a customer's database, and it is checked with one round trip.
// Each connect of the pool tells the job's Dialer when its login is done (settling).
func newPool(ctx context.Context, connector driver.Connector, dialer *reach.Dialer) (*sql.DB, error) {
	db := sql.OpenDB(settling{connector, dialer})
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	pingCtx, cancel := context.WithTimeout(ctx, ConnectTimeout)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// settling tells the Dialer that a login is done, each time the pool connects. The Dialer bounds a
// login with a deadline on its connection (LoginFor), and closes a connection that is still in
// its login when the job ends (Until). Both stay on a connection until Settled. A pool connects
// more than once: after a connection broke, its next statement opens a new session. Settled only
// after a job's first connect, such a later session kept its login's deadline, and stopped
// answering LoginFor after it was dialed, on every driver that leaves its connection's deadline
// alone: SQL Server's, PostgreSQL's and MySQL's.
type settling struct {
	driver.Connector
	dialer *reach.Dialer
}

func (c settling) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.Connector.Connect(ctx)
	if err == nil && c.dialer != nil {
		c.dialer.Settled()
	}
	return conn, err
}

// tableKey is how write sets and catalogs name a table.
func tableKey(schema, name string) string { return schema + "." + name }

// WriteCheck turns a write set into the contract's check, naming at most named tables.
func WriteCheck(w WriteSet, named int) job.WriteCheck {
	tables := make([]string, 0, len(w.Tables))
	for t := range w.Tables {
		tables = append(tables, t)
	}
	sort.Strings(tables)
	count := len(tables)
	if len(tables) > named {
		tables = tables[:named]
	}
	powers := append([]string{}, w.Powers...)
	return job.WriteCheck{
		CanWrite:       count > 0 || len(powers) > 0,
		WritableCount:  count,
		WritableTables: tables,
		Powers:         powers,
	}
}

// catalogBuilder collects tables in order and their columns by key.
type catalogBuilder struct {
	order  []string
	tables map[string]*job.Table
}

func newCatalogBuilder() *catalogBuilder {
	return &catalogBuilder{tables: map[string]*job.Table{}}
}

func (b *catalogBuilder) addTable(t job.Table) {
	key := tableKey(t.Schema, t.Name)
	if _, seen := b.tables[key]; seen {
		return
	}
	t.Columns = []job.Column{}
	b.order = append(b.order, key)
	b.tables[key] = &t
}

func (b *catalogBuilder) addColumn(schema, table string, c job.Column) {
	if t, ok := b.tables[tableKey(schema, table)]; ok {
		t.Columns = append(t.Columns, c)
	}
}

func (b *catalogBuilder) setKey(schema, table, column string, position int) {
	t, ok := b.tables[tableKey(schema, table)]
	if !ok {
		return
	}
	for i := range t.Columns {
		if t.Columns[i].Name == column {
			t.Columns[i].Key = position
		}
	}
}

func (b *catalogBuilder) has(schema, table string) bool {
	_, ok := b.tables[tableKey(schema, table)]
	return ok
}

func (b *catalogBuilder) catalog(engine, database string, truncated bool, writes WriteSet) job.Catalog {
	tables := make([]job.Table, 0, len(b.order))
	for _, key := range b.order {
		t := *b.tables[key]
		t.Writable = writes.Tables[key]
		tables = append(tables, t)
	}
	return job.Catalog{Engine: engine, Database: database, Tables: tables, Truncated: truncated}
}

// rowsOrNil turns a nullable estimate into the contract's rows: nil when unknown or negative.
func rowsOrNil(v sql.NullInt64) *int64 {
	if !v.Valid || v.Int64 < 0 {
		return nil
	}
	n := v.Int64
	return &n
}

// firstLine is a version string's first line, trimmed.
func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	return s
}

// ClassifyCommon names what every engine's errors share: a deadline, a login the server sent on to
// another address, a refused or cut connection, and a certificate the server's name does not match.
func ClassifyCommon(err error) (code, message string, ok bool) {
	if addr, redirected := reach.AsRedirect(err); redirected {
		// The runner words this refusal itself, with the engine's own fix (run's sentOnWords).
		return "unreachable", fmt.Sprintf("The server sent the connection on to %s. A data job connects only to the server its connection names.", addr), true
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline", "The database did not answer before the job's deadline.", true
	}
	var refusal *secure.Refusal
	if errors.As(err, &refusal) {
		// A certificate the job's TLS settings refused, or settings that cannot be read: the
		// refusal's own words say what was named, what was expected and what to change.
		return "tls", refusal.Words, true
	}
	text := err.Error()
	lower := strings.ToLower(text)
	if strings.Contains(lower, "handshake") && (errors.Is(err, io.EOF) || strings.HasSuffix(lower, "eof")) {
		// Closed in the middle of TLS: a broken path to the server closes the same way, so this is
		// the path's question, not the certificate's.
		return "unreachable", "The connection closed during the TLS handshake.", true
	}
	switch {
	case strings.Contains(lower, "x509:") || strings.Contains(lower, "certificate"):
		return "tls", "The server's certificate was not accepted: " + fromTLSWords(text), true
	case strings.Contains(lower, "tls") && (strings.Contains(lower, "handshake") || strings.Contains(lower, "protocol version")):
		return "tls", "TLS with the server failed: " + fromTLSWords(text), true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "unreachable", "The server did not answer in time.", true
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || strings.Contains(lower, "connection refused") ||
		strings.Contains(lower, "connection reset") || strings.Contains(lower, "broken pipe") ||
		strings.HasSuffix(lower, ": eof") || lower == "eof" {
		return "unreachable", "The connection to the server closed before it answered.", true
	}
	return "", "", false
}

// fromTLSWords is a driver's message from the TLS library's own words on ("x509: certificate is
// valid for a, not b"), dropping what the driver wrapped around them.
func fromTLSWords(text string) string {
	lower := strings.ToLower(text)
	for _, marker := range []string{"x509: ", "tls: "} {
		if i := strings.LastIndex(lower, marker); i >= 0 {
			return trimDriverText(text[i:])
		}
	}
	return trimDriverText(text)
}

// trimDriverText keeps a driver's message to one line of reasonable length.
func trimDriverText(s string) string {
	s = firstLine(s)
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}
