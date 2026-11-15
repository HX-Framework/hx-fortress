// Package push is the data runner's part of a PUSH and a COMPARE (DB Connect, F3). A data job of
// kind `compare` does a push's preview or a compare, with the connection's read login; one of kind
// `push` writes a preview's rows, or undoes a write, with its write login. Which one a job does is
// its store job's kind, which the runner reads from the store. The wire is the store gateway's:
// contract/push/ holds one example of each body and answer.
//
// Every read of the database's rows is by key, a batch of keys at a time, so a job reads only the
// rows of the keys it works on: never the rest of a table other stores write into too. A preview's
// links are read by value, the same way. A value of the store's and one of the database's are
// compared as the database's column reads them (engine.Same), and hashed apart (pull.RowHash): the
// store's values as the store keeps them, the database's as engine.Text reads them.
package push

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/pull"
)

// waitPoll is how often the runner asks whether the store has started this job.
const waitPoll = 2 * time.Second

// Described is a table of the database: its columns in order, its primary key's columns in key
// order, and the columns a new row must give a value.
type Described struct {
	Columns  []engine.Column
	Key      []string
	Required []string
}

// Database is the database's side of the job.
type Database interface {
	Describe(ctx context.Context, t Table) (Described, error)
	// Count counts the table's rows.
	Count(ctx context.Context, t Table) (int64, error)
	// Rows reads the rows whose key is one of keys (each its key's columns' values as text, in key
	// order), each with every column of `columns`, in order, as engine.Text reads it; in no order.
	Rows(ctx context.Context, t Table, columns []engine.Column, key []int, keys [][]*string) ([][]*string, error)
	// Linked reads which of values the table's column holds: the column's distinct values among them,
	// each as engine.Text reads it, in no order. Each value is bound as engine.Bind binds it there.
	Linked(ctx context.Context, t Table, column engine.Column, values []*string) ([]*string, error)
	// RollsBack says whether the table's changes roll back with their transaction, and names the
	// engine that keeps it when they do not (MySQL's MyISAM).
	RollsBack(ctx context.Context, t Table) (string, bool, error)
	// Write begins a transaction: one batch's, or a one-transaction job's whole. While it is open the
	// job's one connection is its own: every other read waits for it to end.
	Write(ctx context.Context) (Batch, error)
}

// Batch is a write's transaction on the database: one batch's, or a one-transaction job's.
type Batch interface {
	// Rows reads as Database.Rows does, inside the transaction; lock takes the rows until it ends.
	Rows(ctx context.Context, t Table, columns []engine.Column, key []int, keys [][]*string, lock bool) ([][]*string, error)
	// Insert inserts rows of every column, in order.
	Insert(ctx context.Context, t Table, columns []engine.Column, rows [][]*string) error
	// Update sets the columns at `set` of the one row whose key (at `key`) is row's.
	Update(ctx context.Context, t Table, columns []engine.Column, set, key []int, row []*string) error
	// Delete deletes the rows whose key is one of keys.
	Delete(ctx context.Context, t Table, columns []engine.Column, key []int, keys [][]*string) error
	// CheckDeferred checks now what the database would check only at the commit (Postgres's and
	// Oracle's deferred constraints): a rehearsal, which never commits, runs it before its rollback.
	CheckDeferred(ctx context.Context) error
	Commit() error
	Rollback() error
}

// Deps are what a job uses, so tests can replace each.
type Deps struct {
	// Kind is the data job's: push writes (a write or an undo, with the write login), compare reads (a
	// preview or a compare, with the read login).
	Kind     string
	Store    Store
	Database Database
	// Engine is the database's engine, which says how its values compare.
	Engine string
	// Classify turns a database error into the job's error, saying what it was doing.
	Classify func(err error, doing string) *job.Error
	Now      func() time.Time
	Sleep    func(ctx context.Context, d time.Duration) error
	Logf     func(format string, args ...any)
}

// Counts are what the runner did, for its output. The store's own job answers what it kept.
type Counts struct {
	// Job is the store job's kind: push_preview, push, compare or push_undo.
	Job string
	// A preview's and a compare's: rows of the store's table read, rows of the database's table, rows
	// sent, keys the same on both sides, and the database's rows this store neither holds nor wrote.
	Read, TargetRows, Sent, Same, OtherRows int64
	// A write's and an undo's: the rows the database inserted, updated and deleted, and the rows held.
	// An undo's inserted rows are the ones its write removed, inserted again; its updated ones were put
	// back, and its deleted ones were the ones its write inserted.
	Batches, Inserted, Updated, Deleted, Held int64
	// A rehearsal's: its transaction rolled back, and the rows read back after it holding what they
	// held before.
	RolledBack bool
	Restored   int64
	// A preview's links, as the store heard them.
	Links []LinkCount
}

// add counts another batch's rows.
func (c *Counts) add(o Counts) {
	c.Inserted += o.Inserted
	c.Updated += o.Updated
	c.Deleted += o.Deleted
	c.Held += o.Held
}

type runState struct {
	Deps
	counts Counts
}

// Run does the job its store job names, and answers what it did, or the job's error.
func Run(ctx context.Context, d Deps) (Counts, *job.Error) {
	r := &runState{Deps: d}
	st, failure := r.waitUntilTaking(ctx)
	if failure != nil {
		return r.counts, failure
	}
	r.counts.Job = st.Kind
	if writes(st.Kind) != (d.Kind == "push") {
		return r.counts, job.Fail("store", "The store's job is a %s, which a %s data job does not do.", st.Kind, d.Kind)
	}
	if st.State != "taking" {
		// An earlier data job did the runner's part: the store is finishing, or has.
		return r.counts, nil
	}
	switch st.Kind {
	case "push_preview":
		failure = r.preview(ctx, st)
	case "compare":
		failure = r.compare(ctx, st)
	case "push":
		if st.OneTransaction || st.Rehearse || len(st.Parts) > 1 {
			failure = r.writeAll(ctx, st)
		} else {
			failure = r.write(ctx, st)
		}
	case "push_undo":
		failure = r.undo(ctx, st)
	default:
		failure = job.Fail("store", "The store's job is a %s, which this data job does not do.", st.Kind)
	}
	return r.counts, failure
}

// writes says a store job's kind writes into the database: a data job of kind push does it, with the
// write login.
func writes(kind string) bool { return kind == "push" || kind == "push_undo" }

func (r *runState) waitUntilTaking(ctx context.Context) (State, *job.Error) {
	for {
		st, err := r.Store.State(ctx)
		if err != nil {
			return State{}, r.storeFailure(ctx, err, "read where the job stands")
		}
		switch st.State {
		case "taking", "finishing", "done":
			return st, nil
		case "waiting":
			r.Logf("the store runs another job first")
			if err := r.Sleep(ctx, waitPoll); err != nil {
				return State{}, job.Fail("deadline", "The job reached its deadline while the store ran another job.")
			}
		default:
			why := "The store ended this job."
			if st.Error != nil && *st.Error != "" {
				why = *st.Error
			}
			return State{}, job.Fail("store", "%s", why)
		}
	}
}

func (r *runState) storeFailure(ctx context.Context, err error, doing string) *job.Error {
	if pull.KeyRefused(err) {
		return job.Fail("store", "A newer data job took this job over.")
	}
	if words := pull.AtWriteLimit(err); words != "" {
		return job.Fail("store_limit", "%s", words)
	}
	if ctx.Err() != nil {
		return job.Fail("deadline", "The job reached its deadline while it tried to %s.", doing)
	}
	return job.Fail("store", "Could not %s: %s", doing, pull.FirstLine(err.Error()))
}

// jobColumns are the database's columns the job works on, in the store's order of `names`, and where
// its key's columns are among them.
func jobColumns(all []engine.Column, names, key []string, t Table) ([]engine.Column, []int, *job.Error) {
	cols := make([]engine.Column, len(names))
	for i, name := range names {
		at := slices.IndexFunc(all, func(c engine.Column) bool { return c.Name == name })
		if at < 0 {
			return nil, nil, job.Fail("database", "%s has no column %s any more, or this login cannot read it. Preview again.", t, name)
		}
		cols[i] = all[at]
	}
	keyAt := make([]int, len(key))
	for i, k := range key {
		at := slices.Index(names, k)
		if at < 0 {
			return nil, nil, job.Fail("store", "The store named a key column, %s, that is not among the job's columns.", k)
		}
		keyAt[i] = at
	}
	if len(keyAt) == 0 {
		return nil, nil, job.Fail("store", "The store named no key for %s.", t)
	}
	return cols, keyAt, nil
}

// keyValues are a key's columns' values from its text (pull.KeyText): the text itself for a key of
// one column, the JSON array's items for one of several.
func keyValues(key string, n int) ([]*string, error) {
	if n == 1 {
		v := key
		return []*string{&v}, nil
	}
	var values []*string
	if err := json.Unmarshal([]byte(key), &values); err != nil || len(values) != n {
		return nil, fmt.Errorf("a key of %d columns that does not read as %d values", n, n)
	}
	return values, nil
}

// widen puts a key's values where its columns are in a row of width columns, for CanonKey.
func widen(values []*string, keyAt []int, width int) []*string {
	row := make([]*string, width)
	for i, at := range keyAt {
		row[at] = values[i]
	}
	return row
}

// keysOf are rows' key columns' values, in key order.
func keysOf(rows [][]*string, keyAt []int) [][]*string {
	out := make([][]*string, len(rows))
	for i, row := range rows {
		k := make([]*string, len(keyAt))
		for j, at := range keyAt {
			k[j] = row[at]
		}
		out[i] = k
	}
	return out
}

// byKey finds the database's rows by their keys as the column kinds read them, and without regard to
// case a row the read answered for no key it asked for exactly: only a collation that ignores case
// answers one. A row a key asked for exactly is that key's alone, so on a database that minds case,
// 'abc' never takes the row of 'ABC'.
type byKey struct {
	exact  map[string][]*string
	folded map[string][]*string
	engine string
	cols   []engine.Column
	keyAt  []int
}

// indexRows indexes the database's rows of the keys a read asked for (`asked`, each key's values in
// key order). Two rows of one key: the key is not unique there.
func indexRows(eng string, cols []engine.Column, keyAt []int, rows, asked [][]*string, t Table, key []string) (*byKey, *job.Error) {
	b := &byKey{exact: make(map[string][]*string, len(rows)), folded: make(map[string][]*string, len(rows)), engine: eng, cols: cols, keyAt: keyAt}
	exactly := make(map[string]bool, len(asked))
	for _, k := range asked {
		exactly[engine.CanonKey(eng, cols, widen(k, keyAt, len(cols)), keyAt)] = true
	}
	for _, row := range rows {
		k := engine.CanonKey(eng, cols, row, keyAt)
		if _, twice := b.exact[k]; twice {
			return nil, job.Fail("database", "The key %s names more than one row of %s: name a key that is unique there.", strings.Join(key, ", "), t)
		}
		b.exact[k] = row
		if exactly[k] {
			continue
		}
		f := engine.FoldKey(eng, cols, row, keyAt)
		if _, seen := b.folded[f]; seen {
			b.folded[f] = nil
		} else {
			b.folded[f] = row
		}
	}
	return b, nil
}

// find is the database's row of a row's key (its values at the job's columns), or nil.
func (b *byKey) find(row []*string) []*string {
	if found, ok := b.exact[engine.CanonKey(b.engine, b.cols, row, b.keyAt)]; ok {
		return found
	}
	return b.folded[engine.FoldKey(b.engine, b.cols, row, b.keyAt)]
}

// differing are the columns, outside the key, whose store and database values are not the same.
func differing(eng string, cols []engine.Column, keyAt []int, store, db []*string) []string {
	out := []string{}
	for i, c := range cols {
		if slices.Contains(keyAt, i) {
			continue
		}
		if !engine.Same(eng, c, store[i], db[i]) {
			out = append(out, c.Name)
		}
	}
	return out
}

// sameRow says every column of a row holds the same on both sides.
func sameRow(eng string, cols []engine.Column, store, db []*string) bool {
	for i, c := range cols {
		if !engine.Same(eng, c, store[i], db[i]) {
			return false
		}
	}
	return true
}

func strp(s string) *string { return &s }

// decodeRows reads a page of the store's rows of values, each of width values.
func decodeRows(raw []json.RawMessage, width int) ([][]*string, error) {
	rows := make([][]*string, len(raw))
	for i, r := range raw {
		var row []*string
		if err := json.Unmarshal(r, &row); err != nil {
			return nil, err
		}
		if len(row) != width {
			return nil, fmt.Errorf("a row of %d values where the job has %d columns", len(row), width)
		}
		rows[i] = row
	}
	return rows, nil
}

// memo is what the store last wrote of a key, or found there already holding its values: the hash
// of what it sent, of what the database held after, and whether this store put the row there (it
// inserted it). Only a row this store put there is ever removed.
type memo struct {
	sent, held string
	put        bool
}

// readMemory reads the store's memory of what it wrote into the table: rows of [key, sent, held, put].
func (r *runState) readMemory(ctx context.Context, limits Limits) (map[string]memo, *job.Error) {
	m := map[string]memo{}
	var after *string
	for {
		answer, err := r.Store.Read(ctx, ReadBody{Part: "memory", After: after, Limit: limits.ReadRows})
		if err != nil {
			return nil, r.storeFailure(ctx, err, "read what the store wrote before")
		}
		for _, raw := range answer.Rows {
			var row []json.RawMessage
			var key, sent, held string
			var put bool
			if json.Unmarshal(raw, &row) != nil || len(row) != 4 || json.Unmarshal(row[0], &key) != nil ||
				json.Unmarshal(row[1], &sent) != nil || json.Unmarshal(row[2], &held) != nil || json.Unmarshal(row[3], &put) != nil {
				return nil, job.Fail("store", "The store answered its memory in a shape this runner cannot read.")
			}
			m[key] = memo{sent: sent, held: held, put: put}
		}
		if answer.Next == nil {
			return m, nil
		}
		after = answer.Next
	}
}

// sender sends a job's rows to the store in pages of at most its limits, numbered on from `page`.
type sender struct {
	r      *runState
	limits Limits
	page   int64
	rows   []any
	bytes  int
}

func (s *sender) add(ctx context.Context, row any) *job.Error {
	encoded, err := json.Marshal(row)
	if err != nil {
		return job.Fail("internal", "A row could not be written as JSON: %s", err)
	}
	if len(s.rows) > 0 && (len(s.rows) >= s.limits.SendRows || s.bytes+len(encoded) > s.limits.SendBytes) {
		if failure := s.flush(ctx); failure != nil {
			return failure
		}
	}
	s.rows = append(s.rows, json.RawMessage(encoded))
	s.bytes += len(encoded) + 1
	s.r.counts.Sent++
	return nil
}

func (s *sender) flush(ctx context.Context) *job.Error {
	if len(s.rows) == 0 {
		return nil
	}
	s.page++
	answer, err := s.r.Store.Send(ctx, SendBody{Page: s.page, Rows: s.rows})
	if err != nil {
		return s.r.storeFailure(ctx, err, fmt.Sprintf("send page %d", s.page))
	}
	if !answer.Taken {
		s.r.Logf("page %d was taken before", s.page)
	}
	s.rows, s.bytes = nil, 0
	return nil
}

func i64(n int64) *int64 { return &n }
