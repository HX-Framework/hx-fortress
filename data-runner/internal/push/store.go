package push

// The store's side of a push, a preview, a compare and an undo, as the store's gateway serves it:
// the job's routes under `rows`, each call with the job's key. contract/push/ holds one example of
// each body and answer, which the gateway's side reads too.

import (
	"context"
	"encoding/json"
	"time"

	"hx-fortress/data-runner/internal/pull"
)

// Table is a table of the database, as its catalog names it.
type Table struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
}

func (t Table) String() string { return t.Schema + "." + t.Name }

// Limits are what the store reads and takes at once.
type Limits struct {
	ReadRows  int `json:"readRows"`
	SendRows  int `json:"sendRows"`
	SendBytes int `json:"sendBytes"`
	BatchRows int `json:"batchRows"`
}

// Part is one database's table a job works on: a write's preview, or an undo's part of its write.
type Part struct {
	Target  Table    `json:"target"`
	Key     []string `json:"key"`
	Columns []string `json:"columns"`
}

// LinkTo is the table a link's value names a row of, and the column it names the row by.
type LinkTo struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Column string `json:"column"`
}

// String is `schema.table.column`.
func (l LinkTo) String() string { return l.Schema + "." + l.Name + "." + l.Column }

// LinkSpec is a link a preview counts: a column of the write whose value names a row of another table
// of the same database by one of its columns, with no foreign key to say so.
type LinkSpec struct {
	// Column is the write's column, as the database's table names it.
	Column string `json:"column"`
	To     LinkTo `json:"to"`
}

// LinkCount is how a preview's rows to write fare against one link: counts only.
type LinkCount struct {
	Column string `json:"column"`
	// To is `schema.table.column`.
	To string `json:"to"`
	// Linked rows' values find a row there; unlinked ones find none; empty ones are NULL or empty text.
	Linked   int64 `json:"linked"`
	Unlinked int64 `json:"unlinked"`
	Empty    int64 `json:"empty"`
}

// State is where the job stands, and what it does.
type State struct {
	// Kind is push_preview, push, compare or push_undo.
	Kind string `json:"kind"`
	// State is waiting, taking, finishing, done or failed.
	State      string   `json:"state"`
	Error      *string  `json:"error"`
	Target     Table    `json:"target"`
	Key        []string `json:"key"`
	Columns    []string `json:"columns"`
	TheirEdits string   `json:"theirEdits"`
	// Removes says a preview removes the rows this store put there that its table no longer holds.
	Removes bool    `json:"removes"`
	Begun   bool    `json:"begun"`
	Page    int64   `json:"page"`
	Cursor  *string `json:"cursor"`
	// OneTransaction is a write of several previews, a rehearsal or an undo: the whole of it in one
	// transaction, begun again by each data job, and taken by the store only at its end.
	OneTransaction bool `json:"oneTransaction"`
	// Rehearse rolls the one transaction back.
	Rehearse bool `json:"rehearse"`
	// Parts are the tables the job works on, in write order; Target, Key and Columns are the first's.
	Parts []Part `json:"parts"`
	// Links are a preview's links to count.
	Links  []LinkSpec `json:"links"`
	Limits Limits     `json:"limits"`
}

// parts are the job's tables in write order: the store's parts, or its one table when it names none.
func (s State) parts() []Part {
	if len(s.Parts) > 0 {
		return s.Parts
	}
	return []Part{{Target: s.Target, Key: s.Key, Columns: s.Columns}}
}

// BeginColumn is a column of the database's table as the runner read it.
type BeginColumn struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

// BeginBody is the database's table, for a preview's or a compare's begin.
type BeginBody struct {
	Columns    []BeginColumn `json:"columns"`
	PrimaryKey []string      `json:"primaryKey"`
}

// BeginAgainBody begins a one-transaction write or an undo again: the store forgets what it took of
// the job.
type BeginAgainBody struct {
	Again bool `json:"again"`
}

// BeginAnswer is what the job reads and writes. Begun again, a write or an undo answers only Rows: its
// rows to write or undo.
type BeginAnswer struct {
	Columns []string `json:"columns"`
	Key     []string `json:"key"`
	Missing []string `json:"missing"`
	Rows    int64    `json:"rows"`
}

// ReadBody asks for rows the store holds for the job: its memory, its table's rows, a write's rows to
// write, or an undo's rows to undo.
type ReadBody struct {
	Part  string  `json:"part"`
	After *string `json:"after"`
	Limit int     `json:"limit,omitempty"`
	// Table is a write's or an undo's part: which of its tables (the first, 0, is left out).
	Table int `json:"table,omitempty"`
	// Only is a one-transaction write's or an undo's rows of one kind: puts (new and changed rows; an
	// undo's inserted and updated ones) or removals (removed rows; an undo's deleted ones).
	Only string `json:"only,omitempty"`
}

// ReadAnswer is a page of rows; Next is nil after the last.
type ReadAnswer struct {
	Rows []json.RawMessage `json:"rows"`
	Next *string           `json:"next"`
}

// WriteRow is a row a push writes, as the preview found it.
type WriteRow struct {
	Key     string    `json:"key"`
	Action  string    `json:"action"`
	Now     *string   `json:"now"`
	Values  []*string `json:"values"`
	Changed []string  `json:"changed"`
}

// UndoRow is a row an undo reads: what its write did there.
type UndoRow struct {
	Key string `json:"key"`
	// Did is inserted, updated or deleted.
	Did string `json:"did"`
	// Held is, for an inserted or updated row, the hash of what the database held right after the write.
	Held *string `json:"held"`
	// Set is, for an updated row, the columns the write set.
	Set []string `json:"set"`
	// Before is, for an updated or deleted row, the database's values before the write, in the part's
	// columns order.
	Before []*string `json:"before"`
	// Whole is, for an inserted or deleted row, the hash of the table's other columns (those the write
	// does not write) right after the insert or right before the delete; nil when the table had none.
	Whole *string `json:"whole"`
}

// UndoneRow is how one row of an undo ended: undone, or held, and for a held row why (Why): changed in
// the database since the write (changed), other columns that held values an undo cannot put back
// (columns), or a value too long to have been kept (too_long).
type UndoneRow struct {
	Key     string `json:"key"`
	Outcome string `json:"outcome"`
	Why     string `json:"why,omitempty"`
}

// PreviewRow is a row a preview sends.
type PreviewRow struct {
	Key     string    `json:"key"`
	Action  string    `json:"action"`
	Now     *string   `json:"now"`
	Will    *string   `json:"will"`
	Why     *string   `json:"why"`
	Changed []string  `json:"changed"`
	Before  []*string `json:"before"`
	After   []*string `json:"after"`
	// Unlinked are, for a row to write, its link columns whose value finds no row.
	Unlinked []string `json:"unlinked"`
}

// CompareRow is a key whose rows differ.
type CompareRow struct {
	Key        string    `json:"key"`
	Difference string    `json:"difference"`
	Columns    []string  `json:"columns"`
	Store      []*string `json:"store"`
	Database   []*string `json:"database"`
}

// WrittenRow is how one row of a batch ended on the database.
type WrittenRow struct {
	Key     string  `json:"key"`
	Outcome string  `json:"outcome"`
	Sent    *string `json:"sent"`
	Held    *string `json:"held"`
	Why     *string `json:"why"`
	// Did is, for a written row, inserted or updated; nil for one that held its new values already.
	Did *string `json:"did"`
	// Set is, for an updated row, the columns the update set.
	Set []string `json:"set"`
	// Before is, for an updated or removed row, the database's row before the write.
	Before []*string `json:"before"`
	// After is, for a rehearsal's written row, the database's row as the write left it in its
	// transaction.
	After []*string `json:"after"`
	// Whole is, for an inserted row, the hash of the table's other columns (those the write does not
	// write) right after the insert, and for a removed row right before the delete: what an undo checks
	// before it deletes the row, or inserts it again. Nil when the table has no other columns, and in a
	// rehearsal.
	Whole *string `json:"whole,omitempty"`
}

// SendBody is a page of the runner's rows: a preview's, a compare's, a batch's outcomes, or an undo's.
type SendBody struct {
	Page int64   `json:"page"`
	Rows []any   `json:"rows"`
	Last *string `json:"last,omitempty"`
	// Table is a write's or an undo's part the rows are of (the first, 0, is left out).
	Table int `json:"table,omitempty"`
}

// SendAnswer says whether the store took the page.
type SendAnswer struct {
	Page  int64 `json:"page"`
	Taken bool  `json:"taken"`
}

// EndBody is what the runner counted.
type EndBody struct {
	Read       *int64 `json:"read,omitempty"`
	TargetRows *int64 `json:"targetRows,omitempty"`
	Same       *int64 `json:"same,omitempty"`
	OtherRows  *int64 `json:"otherRows,omitempty"`
	Batches    *int64 `json:"batches,omitempty"`
	// Committed: a one-transaction write's or an undo's transaction committed.
	Committed bool `json:"committed,omitempty"`
	// RolledBack: a rehearsal's transaction rolled back.
	RolledBack bool `json:"rolledBack,omitempty"`
	// Restored is a rehearsal's rows read back after the rollback holding exactly what they held before.
	Restored *int64 `json:"restored,omitempty"`
	// Links are a preview's counts, one per link, in the order the job names them.
	Links []LinkCount `json:"links,omitempty"`
}

// EndAnswer says whether the store is making its tables.
type EndAnswer struct {
	Finishing bool `json:"finishing"`
}

// Store is the store's side of the job.
type Store interface {
	State(ctx context.Context) (State, error)
	Begin(ctx context.Context, body BeginBody) (BeginAnswer, error)
	// BeginAgain begins a one-transaction write or an undo again (`{again: true}`).
	BeginAgain(ctx context.Context) (BeginAnswer, error)
	Read(ctx context.Context, body ReadBody) (ReadAnswer, error)
	Send(ctx context.Context, body SendBody) (SendAnswer, error)
	End(ctx context.Context, body EndBody) (EndAnswer, error)
	Fail(ctx context.Context, body pull.FailBody) error
}

// HTTPStore is the store's side over the gateway.
type HTTPStore struct{ c *pull.HTTPStore }

// NewHTTPStore talks to the gateway for one store's one push, preview, compare or undo, with its key.
func NewHTTPStore(gatewayURL, storeID, jobID, key string, sleep func(ctx context.Context, d time.Duration) error) *HTTPStore {
	return &HTTPStore{c: pull.NewJobCaller(gatewayURL, storeID, jobID, key, "rows", sleep)}
}

func (s *HTTPStore) State(ctx context.Context) (State, error) {
	var out State
	err := s.c.Get(ctx, "", &out)
	return out, err
}

func (s *HTTPStore) Begin(ctx context.Context, body BeginBody) (BeginAnswer, error) {
	var out BeginAnswer
	err := s.c.Post(ctx, "/begin", body, &out)
	return out, err
}

func (s *HTTPStore) BeginAgain(ctx context.Context) (BeginAnswer, error) {
	var out BeginAnswer
	err := s.c.Post(ctx, "/begin", BeginAgainBody{Again: true}, &out)
	return out, err
}

func (s *HTTPStore) Read(ctx context.Context, body ReadBody) (ReadAnswer, error) {
	var out ReadAnswer
	err := s.c.Post(ctx, "/read", body, &out)
	return out, err
}

func (s *HTTPStore) Send(ctx context.Context, body SendBody) (SendAnswer, error) {
	var out SendAnswer
	err := s.c.Post(ctx, "/send", body, &out)
	return out, err
}

func (s *HTTPStore) End(ctx context.Context, body EndBody) (EndAnswer, error) {
	var out EndAnswer
	err := s.c.Post(ctx, "/end", body, &out)
	return out, err
}

func (s *HTTPStore) Fail(ctx context.Context, body pull.FailBody) error {
	return s.c.Post(ctx, "/fail", body, nil)
}
