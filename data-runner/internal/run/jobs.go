package run

// A pull, a query, a push and a compare, on the connection the runner opened: the database's side of
// a pull (internal/pull does the rest), one read-only SELECT, and the database's side of a push, its
// preview and a compare (internal/push does the rest).

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/pull"
	"hx-fortress/data-runner/internal/push"
)

// pull sends the store's tables' changed rows from this connection.
func (r *runner) pull(ctx context.Context, eng engine.Engine, db *sql.DB) (*job.PullResult, *job.Error) {
	tables, failure := pull.Run(ctx, pull.Deps{
		Store:    r.d.NewStore(*r.j.Store, r.d.Sleep),
		Database: &sqlDatabase{db: db, engine: r.j.Engine},
		Classify: func(err error, doing string) *job.Error { return r.queryFailure(ctx, eng, err, doing) },
		Now:      r.d.Now,
		Sleep:    r.d.Sleep,
		Logf:     r.logf,
	})
	if failure != nil {
		return nil, failure
	}
	return &job.PullResult{Kind: "pull", Tables: tables}, nil
}

// tellStore says when the store stopped a pull or a push at its daily write limit, so the job stays
// open a day for the next data job to go on from its last page or batch. Every other failure is the
// caller's to judge: it knows whether the store took anything, and whether another data job holds
// the job. A key a newer data job replaced is refused there, and
// changes nothing.
func (r *runner) tellStore(ctx context.Context, out job.Output) {
	if (r.j.Kind != "pull" && r.j.Kind != "push") || r.j.Store == nil || out.OK || out.Error == nil || out.Error.Code != "store_limit" {
		return
	}
	tell, cancel := context.WithTimeout(context.WithoutCancel(ctx), failTimeout)
	defer cancel()
	body := pull.FailBody{Code: out.Error.Code, Message: out.Error.Message}
	var err error
	if r.j.Kind == "pull" {
		err = r.d.NewStore(*r.j.Store, r.d.Sleep).Fail(tell, body)
	} else {
		err = r.d.NewRowsStore(*r.j.Store, r.d.Sleep).Fail(tell, body)
	}
	if err != nil {
		r.logf("the store did not hear the failure: %s", r.scrub(pull.FirstLine(err.Error())))
	}
}

// push does a push's write or an undo of one (kind push, with the write login), or a push's preview or
// a compare (kind compare, with the read login), whichever its store job is. A database's error says no
// row's value: a write's error is the run's to keep, and its rows stay with the store. An undo answers
// as a write does, in the database's words: the rows it inserted again (its write removed them), the
// rows it updated (put back), the rows it deleted (its write inserted them) and the rows it held.
func (r *runner) push(ctx context.Context, eng engine.Engine, db *sql.DB, ms job.PullMS) (job.Result, *job.Error) {
	counts, failure := push.Run(ctx, push.Deps{
		Kind:     r.j.Kind,
		Store:    r.d.NewRowsStore(*r.j.Store, r.d.Sleep),
		Database: &pushDatabase{db: db, engine: r.j.Engine},
		Engine:   r.j.Engine,
		Classify: func(err error, doing string) *job.Error {
			return r.failureOf(ctx, eng, err, doing, engine.ScrubValues)
		},
		Now:   r.d.Now,
		Sleep: r.d.Sleep,
		Logf:  r.logf,
	})
	if failure != nil {
		return nil, failure
	}
	ms.Total = r.since(r.start)
	if r.j.Kind == "push" {
		return &job.PushResult{Kind: "push", Batches: counts.Batches, Inserted: counts.Inserted, Updated: counts.Updated, Deleted: counts.Deleted, Held: counts.Held, MS: ms}, nil
	}
	return &job.CompareResult{Kind: "compare", Job: counts.Job, Read: counts.Read, TargetRows: counts.TargetRows, Sent: counts.Sent, Same: counts.Same, OtherRows: counts.OtherRows, MS: ms}, nil
}

// pushDatabase is the database's side of a push, a preview and a compare, over the job's one
// connection.
type pushDatabase struct {
	db     *sql.DB
	engine string
}

func (p *pushDatabase) Describe(ctx context.Context, t push.Table) (push.Described, error) {
	columns, err := engine.Columns(ctx, p.db, p.engine, t.Schema, t.Name)
	if err != nil {
		return push.Described{}, err
	}
	key, err := engine.KeyColumns(ctx, p.db, p.engine, t.Schema, t.Name)
	if err != nil {
		return push.Described{}, err
	}
	required, err := engine.RequiredColumns(ctx, p.db, p.engine, t.Schema, t.Name)
	if err != nil {
		return push.Described{}, err
	}
	return push.Described{Columns: columns, Key: key, Required: required}, nil
}

func (p *pushDatabase) Count(ctx context.Context, t push.Table) (int64, error) {
	var n int64
	err := p.db.QueryRowContext(ctx, engine.CountRows(p.engine, t.Schema, t.Name)).Scan(&n)
	return n, err
}

// Rows reads by key outside a write: a preview's and a compare's reads. On Oracle the session first
// learns the forms engine.Bind writes a key's date or number in, on the connection the read goes on.
func (p *pushDatabase) Rows(ctx context.Context, t push.Table, columns []engine.Column, key []int, keys [][]*string) ([][]*string, error) {
	if p.engine != "oracle" {
		return rowsByKeys(ctx, p.db, p.engine, t, columns, key, keys, false)
	}
	conn, err := p.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, engine.OracleSession); err != nil {
		return nil, err
	}
	return rowsByKeys(ctx, conn, p.engine, t, columns, key, keys, false)
}

// Linked reads which of values a table's column holds: a preview's links, read by value. On Oracle the
// session first learns the forms engine.Bind writes a date or a number in, as for a read by key.
func (p *pushDatabase) Linked(ctx context.Context, t push.Table, column engine.Column, values []*string) ([]*string, error) {
	if p.engine != "oracle" {
		return valuesIn(ctx, p.db, p.engine, t, column, values)
	}
	conn, err := p.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, engine.OracleSession); err != nil {
		return nil, err
	}
	return valuesIn(ctx, conn, p.engine, t, column, values)
}

// RollsBack says whether a table's changes roll back with their transaction. Only MySQL keeps tables in
// engines without transactions (MyISAM); every table of the other engines' rolls back.
func (p *pushDatabase) RollsBack(ctx context.Context, t push.Table) (string, bool, error) {
	if p.engine != "mysql" {
		return "", true, nil
	}
	return engine.MySQLRollsBack(ctx, p.db, t.Schema, t.Name)
}

// valuesIn reads the column's distinct values among these, as many values a statement as the engine
// binds for a key of one column, each as engine.Text reads it.
func valuesIn(ctx context.Context, q engine.Querier, eng string, t push.Table, column engine.Column, values []*string) ([]*string, error) {
	out := []*string{}
	per := engine.KeysPerRead(eng, 1, len(values))
	for start := 0; start < len(values); start += per {
		chunk := values[start:min(start+per, len(values))]
		args := make([]any, len(chunk))
		for i, v := range chunk {
			args[i] = engine.Bind(eng, column, v)
		}
		rows, err := q.QueryContext(ctx, engine.SelectDistinctIn(eng, t.Schema, t.Name, column, len(chunk)), args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			held, err := engine.Scan(rows, 1)
			if err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, engine.Text(held[0], column))
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Write begins a write's transaction: a batch's, or a one-transaction job's whole. On Oracle it first
// sets how the session reads text into a date, a time and a number, the forms engine.Bind writes.
func (p *pushDatabase) Write(ctx context.Context) (push.Batch, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	if p.engine == "oracle" {
		if _, err := tx.ExecContext(ctx, engine.OracleSession); err != nil {
			_ = tx.Rollback()
			return nil, err
		}
	}
	return &pushBatch{tx: tx, engine: p.engine}, nil
}

// pushBatch is one batch's transaction.
type pushBatch struct {
	tx     *sql.Tx
	engine string
}

func (b *pushBatch) Rows(ctx context.Context, t push.Table, columns []engine.Column, key []int, keys [][]*string, lock bool) ([][]*string, error) {
	return rowsByKeys(ctx, b.tx, b.engine, t, columns, key, keys, lock)
}

func (b *pushBatch) Insert(ctx context.Context, t push.Table, columns []engine.Column, rows [][]*string) error {
	per := engine.RowsPerInsert(b.engine, len(columns), len(rows))
	for start := 0; start < len(rows); start += per {
		chunk := rows[start:min(start+per, len(rows))]
		args := make([]any, 0, len(chunk)*len(columns))
		for _, row := range chunk {
			for i, c := range columns {
				args = append(args, engine.Bind(b.engine, c, row[i]))
			}
		}
		if _, err := b.tx.ExecContext(ctx, engine.InsertRows(b.engine, t.Schema, t.Name, columns, len(chunk)), args...); err != nil {
			return err
		}
	}
	return nil
}

func (b *pushBatch) Update(ctx context.Context, t push.Table, columns []engine.Column, set, key []int, row []*string) error {
	args := make([]any, 0, len(set)+len(key))
	for _, at := range set {
		args = append(args, engine.Bind(b.engine, columns[at], row[at]))
	}
	for _, at := range key {
		args = append(args, engine.Bind(b.engine, columns[at], row[at]))
	}
	_, err := b.tx.ExecContext(ctx, engine.UpdateRow(b.engine, t.Schema, t.Name, columns, set, key), args...)
	return err
}

func (b *pushBatch) Delete(ctx context.Context, t push.Table, columns []engine.Column, key []int, keys [][]*string) error {
	per := engine.KeysPerRead(b.engine, len(key), len(keys))
	for start := 0; start < len(keys); start += per {
		chunk := keys[start:min(start+per, len(keys))]
		if _, err := b.tx.ExecContext(ctx, engine.DeleteByKeys(b.engine, t.Schema, t.Name, columns, key, len(chunk)), keyArgs(b.engine, columns, key, chunk)...); err != nil {
			return err
		}
	}
	return nil
}

func (b *pushBatch) Commit() error   { return b.tx.Commit() }
func (b *pushBatch) Rollback() error { return b.tx.Rollback() }

// CheckDeferred makes Postgres and Oracle check their deferred constraints now; MySQL and SQL Server
// check every constraint as each statement runs.
func (b *pushBatch) CheckDeferred(ctx context.Context) error {
	if b.engine != "postgres" && b.engine != "oracle" {
		return nil
	}
	_, err := b.tx.ExecContext(ctx, "SET CONSTRAINTS ALL IMMEDIATE")
	return err
}

// keyArgs are keys' values as the statement binds them, each key's columns in key order.
func keyArgs(eng string, columns []engine.Column, key []int, keys [][]*string) []any {
	args := make([]any, 0, len(keys)*len(key))
	for _, k := range keys {
		for j, at := range key {
			args = append(args, engine.Bind(eng, columns[at], k[j]))
		}
	}
	return args
}

// rowsByKeys reads the rows of these keys, as many keys a statement as the engine binds, each value as
// engine.Text reads it.
func rowsByKeys(ctx context.Context, q engine.Querier, eng string, t push.Table, columns []engine.Column, key []int, keys [][]*string, lock bool) ([][]*string, error) {
	out := [][]*string{}
	per := engine.KeysPerRead(eng, len(key), len(keys))
	for start := 0; start < len(keys); start += per {
		chunk := keys[start:min(start+per, len(keys))]
		rows, err := q.QueryContext(ctx, engine.SelectByKeys(eng, t.Schema, t.Name, columns, key, len(chunk), lock), keyArgs(eng, columns, key, chunk)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			values, err := engine.Scan(rows, len(columns))
			if err != nil {
				rows.Close()
				return nil, err
			}
			row := make([]*string, len(values))
			for i, v := range values {
				row[i] = engine.Text(v, columns[i])
			}
			out = append(out, row)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// failTimeout bounds telling the store a pull failed: the job's own context may have ended.
const failTimeout = 15 * time.Second

// sqlDatabase is the database's side of a pull, over the job's one connection.
type sqlDatabase struct {
	db     engine.Querier
	engine string
}

// Describe reads a table's columns and its primary key.
func (s *sqlDatabase) Describe(ctx context.Context, table pull.Source) ([]engine.Column, []string, error) {
	columns, err := engine.Columns(ctx, s.db, s.engine, table.Schema, table.Name)
	if err != nil {
		return nil, nil, err
	}
	key, err := engine.KeyColumns(ctx, s.db, s.engine, table.Schema, table.Name)
	if err != nil {
		return nil, nil, err
	}
	return columns, key, nil
}

// Read reads the table's rows, in no order.
func (s *sqlDatabase) Read(ctx context.Context, table pull.Source, columns []engine.Column) (pull.Rows, error) {
	reading, stop := context.WithCancel(ctx)
	rows, err := s.db.QueryContext(reading, engine.Select(s.engine, table.Schema, table.Name, columns))
	if err != nil {
		stop()
		return nil, err
	}
	return &sqlRows{rows: rows, columns: columns, stop: stop}, nil
}

type sqlRows struct {
	rows    *sql.Rows
	columns []engine.Column
	stop    context.CancelFunc
}

func (r *sqlRows) Next() bool { return r.rows.Next() }
func (r *sqlRows) Err() error { return r.rows.Err() }

// Close stops the read first: on Postgres and MySQL, closing rows that are not at their end reads
// the rest of the table.
func (r *sqlRows) Close() error {
	r.stop()
	return r.rows.Close()
}

func (r *sqlRows) Values() ([]*string, error) {
	values, err := engine.Scan(r.rows, len(r.columns))
	if err != nil {
		return nil, err
	}
	out := make([]*string, len(values))
	for i, v := range values {
		out[i] = engine.Text(v, r.columns[i])
	}
	return out, nil
}

// query runs one read-only SELECT and answers its first rows.
func (r *runner) query(ctx context.Context, eng engine.Engine, db *sql.DB) (*job.QueryResult, *job.Error) {
	text, limit := r.j.QuerySQL()
	// run read the statement before it opened anything. It is read again here, where it runs, so
	// that no way to this point sends a statement that was not read.
	if why := engine.QueryRefusal(r.j.Engine, text); why != "" {
		return nil, job.Fail("database", "%s", why)
	}
	// The check read the text as it is written. A statement with a character outside ASCII runs
	// only where the database reads that character as written too (engine.CharacterSetRefusal).
	why, err := engine.CharacterSetRefusal(ctx, db, r.j.Engine, text)
	if err != nil {
		return nil, r.queryFailure(ctx, eng, err, "ask which character set the database reads a query in")
	}
	if why != "" {
		r.logf("query: not run: it holds a character outside ASCII, and the database would read another in its place")
		return nil, job.Fail("database", "%s", why)
	}
	start := r.d.Now()
	tx, rows, stop, failure := r.startQuery(ctx, eng, db, text)
	if failure != nil {
		return nil, failure
	}
	// Nothing a query does stays: on SQL Server, the one engine with no read-only transaction,
	// this and the read login are what keep a statement from writing.
	defer func() { _ = tx.Rollback() }()
	// Stops the read first: on Postgres and MySQL, closing rows that are not at their end reads the
	// rest of the result.
	defer func() {
		stop()
		_ = rows.Close()
	}()
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, r.queryFailure(ctx, eng, err, "read the query's columns")
	}
	columns := engine.ColumnsOf(types)
	result := &job.QueryResult{Kind: "query", Columns: make([]job.QueryColumn, len(columns)), Rows: [][]*string{}}
	for i, c := range columns {
		result.Columns[i] = job.QueryColumn{Name: c.Name, Type: c.Type}
	}
	size := 0
	for rows.Next() {
		if len(result.Rows) >= limit {
			result.Truncated = true
			break
		}
		values, err := engine.Scan(rows, len(columns))
		if err != nil {
			return nil, r.queryFailure(ctx, eng, err, "read a row of the query")
		}
		row := make([]*string, len(values))
		for i, v := range values {
			text := engine.Text(v, columns[i])
			if text != nil && strings.IndexByte(*text, 0) >= 0 {
				// The job's answer is kept as JSON in Postgres, which refuses a NUL.
				clean := strings.ReplaceAll(*text, "\x00", "\uFFFD")
				text = &clean
			}
			if text != nil && utf8.RuneCountInString(*text) > job.QueryCellChars {
				cut := cutRunes(*text, job.QueryCellChars)
				text = &cut
				result.Truncated = true
			}
			row[i] = text
		}
		encoded, _ := json.Marshal(row)
		size += len(encoded) + 1
		if size > job.QueryBytesMax {
			result.Truncated = true
			break
		}
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, r.queryFailure(ctx, eng, err, "read the query's rows")
	}
	result.MS.Query = r.since(start)
	r.logf("query: %d rows in %d ms", len(result.Rows), result.MS.Query)
	return result, nil
}

// QueryRetryWait is how long a query Oracle refused with ORA-01466 waits before it runs once more,
// in a new read-only transaction. A read-only transaction reads as of the moment it began, and for a
// few seconds after a table was created, truncated or altered, Oracle may refuse to read it as of a
// moment after the change ("unable to read data - table definition has changed"). Oracle's remedy is
// to end the transaction and run the statement again; at once is too soon. TestOraclePullForReal
// measures how long the refusal lasts and fails when it reaches this wait.
const QueryRetryWait = 5 * time.Second

// startQuery begins the read-only transaction and runs the statement in it. When Oracle refuses the
// statement because a table it reads changed moments before (ORA-01466), the statement has read
// nothing: it runs once more, QueryRetryWait later, in a new read-only transaction.
func (r *runner) startQuery(ctx context.Context, eng engine.Engine, db *sql.DB, text string) (*sql.Tx, *sql.Rows, context.CancelFunc, *job.Error) {
	for attempt := 1; ; attempt++ {
		tx, err := beginReadOnly(ctx, db, r.j.Engine)
		if err != nil {
			return nil, nil, nil, r.queryFailure(ctx, eng, err, "start a read-only transaction")
		}
		reading, stop := context.WithCancel(ctx)
		rows, err := tx.QueryContext(reading, text)
		if err == nil {
			return tx, rows, stop, nil
		}
		stop()
		_ = tx.Rollback()
		if attempt > 1 {
			return nil, nil, nil, r.queryFailure(ctx, eng, err, fmt.Sprintf("run the query again %s after Oracle refused it", QueryRetryWait))
		}
		if r.j.Engine != "oracle" || !engine.OracleDefinitionChanged(err) || ctx.Err() != nil {
			return nil, nil, nil, r.queryFailure(ctx, eng, err, "run the query")
		}
		r.logf("query: Oracle refused the read because a table it reads changed moments before (ORA-01466); trying again in %s", QueryRetryWait)
		if err := r.d.Sleep(ctx, QueryRetryWait); err != nil {
			return nil, nil, nil, job.Fail("deadline", "The job reached its deadline while it waited to run the query again.")
		}
	}
}

// cutRunes is s, cut to at most n characters with an ellipsis in place of the rest.
func cutRunes(s string, n int) string {
	at := 0
	for i := 0; i < n-1 && at < len(s); i++ {
		_, size := utf8.DecodeRuneInString(s[at:])
		at += size
	}
	return s[:at] + "…"
}

// beginReadOnly opens the transaction a query runs in, read-only wherever the engine has that.
func beginReadOnly(ctx context.Context, db *sql.DB, engineName string) (*sql.Tx, error) {
	switch engineName {
	case "postgres", "mysql":
		return db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	case "oracle":
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, "SET TRANSACTION READ ONLY"); err != nil {
			_ = tx.Rollback()
			return nil, fmt.Errorf("%w", err)
		}
		return tx, nil
	default:
		return db.BeginTx(ctx, nil)
	}
}
