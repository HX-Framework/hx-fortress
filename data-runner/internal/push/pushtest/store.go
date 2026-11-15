// Package pushtest is a store's side of a push, a preview, a compare and an undo, in memory, for the
// runner's tests: what the store's own push job keeps, without its tables.
package pushtest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"

	"hx-fortress/data-runner/internal/pull"
	"hx-fortress/data-runner/internal/push"
)

// Store is one store job's side, and the store's memory of what it wrote.
type Store struct {
	// Kind is push_preview, push, compare or push_undo.
	Kind       string
	Target     push.Table
	AskedKey   []string
	TheirEdits string
	// Removes asks a preview to remove the rows this store put there that its table no longer holds.
	Removes bool
	// Links are a preview's links to count.
	Links []push.LinkSpec
	// The store's table: its columns and rows.
	SourceColumns []string
	Source        [][]*string
	// What the store wrote before, or found there holding its values, by key.
	Memory map[string]Mem
	Limits push.Limits

	// Set by a begin.
	Columns []string
	Key     []string
	Missing []string
	Begun   bool

	// A preview's rows and a compare's, by key.
	Preview     map[string]push.PreviewRow
	Differences map[string]push.CompareRow
	// A push's: its cursor, outcomes by key, and the keys held since the preview.
	Cursor   *string
	Outcomes map[string]push.WrittenRow

	// A write's other previews, written after this one in the same transaction: each a part of the
	// write with its own memory (ToPushWith). Rehearse rolls the transaction back.
	Also     []*Store
	Rehearse bool
	// Wrote is what this part of a write did to each key it wrote, as the store records it
	// (`_push_writes`): what an undo reads.
	Wrote map[string]*Wrote
	// A rehearsal's: each row of this part as its page came, and the rows read back as they were.
	Manifest map[string]push.WrittenRow
	Restored *int64
	// UndoneBy is the undo that undid this write.
	UndoneBy *Store

	// An undo's: the write it undoes, and how each row ended, by part and key.
	Of     *Store
	Undone []map[string]string
	// UndoneWhy is why the undo held each row it held, by part and key.
	UndoneWhy []map[string]string

	Page   int64
	Ended  *push.EndBody
	Failed *pull.FailBody
	// FailSend makes the n-th Send fail, as a store that never heard of a batch the database took;
	// FailEnd the n-th End, as one that never heard of a transaction the database committed.
	FailSend int
	Sends    int
	FailEnd  int
	Ends     int
	// BegunAgain counts a one-transaction job's begins.
	BegunAgain int

	// A one-transaction job's pages, kept until its end.
	pending []page
}

// Mem is the store's memory of a key: the hash of what it sent and of what the database held after,
// and whether this store put the row there (inserted it).
type Mem struct {
	Sent, Held string
	Put        bool
}

// Wrote is what a write did to one key.
type Wrote struct {
	// Did is inserted, updated or deleted; empty for a row the write found holding its values already,
	// or gone already: those an undo leaves.
	Did    string
	Held   *string
	Set    []string
	Before []*string
	// Whole is the hash of the table's other columns right after the insert, or before the delete.
	Whole *string
	// Mem is the key's memory before the write; nil when it had none.
	Mem *Mem
	// State is done, or undone.
	State string
}

// page is a one-transaction job's page: a write's outcomes or an undo's, of one part.
type page struct {
	table   int
	written []push.WrittenRow
	undone  []push.UndoneRow
}

// New is a store job of this kind over a table, with an empty memory.
func New(kind string, target push.Table, columns []string, rows [][]*string) *Store {
	return &Store{
		Kind: kind, Target: target, TheirEdits: "hold", SourceColumns: columns, Source: rows,
		Memory: map[string]Mem{}, Limits: push.Limits{ReadRows: 3, SendRows: 2, SendBytes: 1 << 20, BatchRows: 2},
		Preview: map[string]push.PreviewRow{}, Differences: map[string]push.CompareRow{}, Outcomes: map[string]push.WrittenRow{},
		Wrote: map[string]*Wrote{}, Manifest: map[string]push.WrittenRow{},
	}
}

// ToPush is the store's push of this finished preview: its rows to write, its columns and key, and
// the same memory.
func (s *Store) ToPush() *Store {
	p := New("push", s.Target, s.SourceColumns, s.Source)
	p.Memory = s.Memory
	p.Limits = s.Limits
	p.Removes = s.Removes
	p.Columns, p.Key, p.Begun = s.Columns, s.Key, false
	p.Preview = s.Preview
	return p
}

// ToPushWith is the store's write of this finished preview and others, in one transaction: this one's
// new and changed rows first, then theirs in order, then every preview's removed rows in the reverse
// order.
func (s *Store) ToPushWith(others ...*Store) *Store {
	p := s.ToPush()
	for _, o := range others {
		p.Also = append(p.Also, o.ToPush())
	}
	return p
}

// Undo is the store's undo of this write.
func (s *Store) Undo() *Store {
	u := New("push_undo", s.Target, s.SourceColumns, nil)
	u.Of = s
	u.Limits = s.Limits
	return u
}

// Again is a fresh job of the same kind on the same table and memory, as the next run makes.
func (s *Store) Again(kind string) *Store {
	n := New(kind, s.Target, s.SourceColumns, s.Source)
	n.Memory = s.Memory
	n.Limits = s.Limits
	n.AskedKey = s.AskedKey
	n.TheirEdits = s.TheirEdits
	n.Removes = s.Removes
	n.Links = s.Links
	return n
}

// Counts are a preview's rows by what would happen.
func (s *Store) Counts() map[string]int {
	out := map[string]int{}
	for _, r := range s.Preview {
		out[r.Action]++
	}
	return out
}

// Parts are a write's tables in write order: this one, then Also. An undo's are its write's.
func (s *Store) Parts() []*Store {
	if s.Of != nil {
		return s.Of.Parts()
	}
	return append([]*Store{s}, s.Also...)
}

// oneTransaction says the job is written, or undone, in one transaction, taken only at its end.
func (s *Store) oneTransaction() bool {
	return s.Kind == "push_undo" || (s.Kind == "push" && (len(s.Also) > 0 || s.Rehearse))
}

func (s *Store) State(context.Context) (push.State, error) {
	st := push.State{Kind: s.Kind, State: "taking", Target: s.Target, Key: s.AskedKey, Columns: []string{}, TheirEdits: s.TheirEdits, Removes: s.Removes, Begun: s.Begun, Page: s.Page, Cursor: s.Cursor, Links: s.Links, Limits: s.Limits}
	switch s.Kind {
	case "push", "push_undo":
		parts := s.Parts()
		st.Target, st.Key, st.Columns = parts[0].Target, parts[0].Key, parts[0].Columns
		st.OneTransaction, st.Rehearse = s.oneTransaction(), s.Rehearse
		for _, p := range parts {
			st.Parts = append(st.Parts, push.Part{Target: p.Target, Key: p.Key, Columns: p.Columns})
		}
		// The store refuses an undo of a rehearsal, and a second undo of a write.
		if s.Of != nil && s.Of.Rehearse {
			st.State, st.Error = "failed", Str("A rehearsal wrote nothing that stayed: there is nothing to undo.")
		}
		if s.Of != nil && s.Of.UndoneBy != nil && s.Of.UndoneBy != s {
			st.State, st.Error = "failed", Str("This write was undone already.")
		}
	default:
		if s.Begun {
			st.Key, st.Columns = s.Key, s.Columns
		}
		st.Parts = []push.Part{{Target: s.Target, Key: st.Key, Columns: st.Columns}}
	}
	if st.Key == nil {
		st.Key = []string{}
	}
	if st.Links == nil {
		st.Links = []push.LinkSpec{}
	}
	if s.Ended != nil && st.State == "taking" {
		st.State = "done"
	}
	return st, nil
}

func (s *Store) Begin(_ context.Context, body push.BeginBody) (push.BeginAnswer, error) {
	if s.Kind == "push" || s.Kind == "push_undo" {
		return push.BeginAnswer{}, errors.New("a write does not begin with the database's columns")
	}
	s.Columns, s.Key, s.Missing = []string{}, []string{}, []string{}
	matched := map[string]bool{}
	for _, c := range body.Columns {
		at := slices.IndexFunc(s.SourceColumns, func(n string) bool { return strings.EqualFold(n, c.Name) })
		if at < 0 || strings.HasPrefix(s.SourceColumns[at], "_") {
			if c.Required {
				s.Missing = append(s.Missing, c.Name)
			}
			continue
		}
		s.Columns = append(s.Columns, c.Name)
		matched[strings.ToLower(c.Name)] = true
	}
	key := s.AskedKey
	if len(key) == 0 {
		key = body.PrimaryKey
	}
	for _, k := range key {
		at := slices.IndexFunc(s.Columns, func(n string) bool { return strings.EqualFold(n, k) })
		if at < 0 {
			return push.BeginAnswer{}, &pull.StoreError{Status: 409, Code: "push_key", Message: "The store's table has no column " + k + "."}
		}
		s.Key = append(s.Key, s.Columns[at])
	}
	if len(s.Key) == 0 {
		return push.BeginAnswer{}, &pull.StoreError{Status: 409, Code: "push_key", Message: "No key."}
	}
	s.Begun, s.Page = true, 0
	s.Preview, s.Differences = map[string]push.PreviewRow{}, map[string]push.CompareRow{}
	return push.BeginAnswer{Columns: s.Columns, Key: s.Key, Missing: s.Missing, Rows: int64(len(s.Source))}, nil
}

// BeginAgain begins a one-transaction write or an undo again: what the store took of the job is
// forgotten, and its pages start over.
func (s *Store) BeginAgain(context.Context) (push.BeginAnswer, error) {
	if !s.oneTransaction() {
		return push.BeginAnswer{}, &pull.StoreError{Status: 400, Code: "bad_request", Message: "This job begins with the database's columns."}
	}
	s.pending, s.Page = nil, 0
	s.BegunAgain++
	rows := 0
	for _, p := range s.Parts() {
		if s.Kind == "push_undo" {
			rows += len(p.undoKeys(nil, ""))
		} else {
			rows += len(p.writeKeys(nil, ""))
		}
	}
	return push.BeginAnswer{Columns: []string{}, Key: []string{}, Missing: []string{}, Rows: int64(rows)}, nil
}

// writeKeys are a part's keys to write after `after`, in order: every kind, or only puts or removals.
func (s *Store) writeKeys(after *string, only string) []string {
	keys := []string{}
	for k, r := range s.Preview {
		kind := r.Action == "new" || r.Action == "changed" || r.Action == "removed"
		switch only {
		case "puts":
			kind = r.Action == "new" || r.Action == "changed"
		case "removals":
			kind = r.Action == "removed"
		}
		if kind && (after == nil || k > *after) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// undoKeys are a written part's keys an undo reads after `after`, in order: the rows its write
// inserted, updated or deleted, not undone; or only those it removed (removals), or only those it
// inserted or updated (puts).
func (s *Store) undoKeys(after *string, only string) []string {
	keys := []string{}
	for k, w := range s.Wrote {
		if only == "removals" && w.Did != "deleted" || only == "puts" && w.Did == "deleted" {
			continue
		}
		if w.State == "done" && w.Did != "" && (after == nil || k > *after) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

func (s *Store) Read(_ context.Context, body push.ReadBody) (push.ReadAnswer, error) {
	limit := body.Limit
	if limit <= 0 {
		limit = s.Limits.ReadRows
	}
	answer := push.ReadAnswer{Rows: []json.RawMessage{}}
	add := func(v any) {
		encoded, _ := json.Marshal(v)
		answer.Rows = append(answer.Rows, encoded)
	}
	page := func(keys []string) []string {
		if len(keys) > limit {
			keys = keys[:limit]
			answer.Next = &keys[len(keys)-1]
		}
		return keys
	}
	switch body.Part {
	case "memory":
		keys := make([]string, 0, len(s.Memory))
		for k := range s.Memory {
			if body.After == nil || k > *body.After {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range page(keys) {
			m := s.Memory[k]
			add([]any{k, m.Sent, m.Held, m.Put})
		}
	case "source":
		offset := 0
		if body.After != nil {
			offset, _ = strconv.Atoi(*body.After)
		}
		end := min(offset+limit, len(s.Source))
		for _, row := range s.Source[offset:end] {
			out := make([]*string, len(s.Columns))
			for i, c := range s.Columns {
				out[i] = row[slices.IndexFunc(s.SourceColumns, func(n string) bool { return strings.EqualFold(n, c) })]
			}
			add(out)
		}
		if end < len(s.Source) {
			next := strconv.Itoa(end)
			answer.Next = &next
		}
	case "write":
		parts := s.Parts()
		if s.Kind != "push" || body.Table >= len(parts) || (body.Only != "" && !s.oneTransaction()) {
			return answer, fmt.Errorf("no part %d of this write's rows, or only %q", body.Table, body.Only)
		}
		p := parts[body.Table]
		for _, k := range page(p.writeKeys(body.After, body.Only)) {
			r := p.Preview[k]
			add(push.WriteRow{Key: k, Action: r.Action, Now: r.Now, Values: r.After, Changed: r.Changed})
		}
	case "undo":
		parts := s.Parts()
		if s.Kind != "push_undo" || body.Table >= len(parts) || (body.Only != "" && body.Only != "puts" && body.Only != "removals") {
			return answer, fmt.Errorf("no part %d of an undo, or only %q", body.Table, body.Only)
		}
		p := parts[body.Table]
		for _, k := range page(p.undoKeys(body.After, body.Only)) {
			w := p.Wrote[k]
			add(push.UndoRow{Key: k, Did: w.Did, Held: w.Held, Set: w.Set, Before: w.Before, Whole: w.Whole})
		}
	default:
		return answer, fmt.Errorf("no part %q", body.Part)
	}
	return answer, nil
}

func (s *Store) Send(_ context.Context, body push.SendBody) (push.SendAnswer, error) {
	s.Sends++
	if s.FailSend == s.Sends {
		return push.SendAnswer{}, &pull.StoreError{Status: 503, Code: "internal", Message: "The store could not take this call just now."}
	}
	if body.Page <= s.Page {
		return push.SendAnswer{Page: body.Page, Taken: false}, nil
	}
	if body.Page != s.Page+1 {
		return push.SendAnswer{}, &pull.StoreError{Status: 409, Code: "page_out_of_order", Message: "out of order"}
	}
	encoded, _ := json.Marshal(body.Rows)
	switch s.Kind {
	case "push_preview":
		var rows []push.PreviewRow
		if err := json.Unmarshal(encoded, &rows); err != nil {
			return push.SendAnswer{}, err
		}
		for _, r := range rows {
			switch r.Action {
			case "adopt":
				s.Memory[r.Key] = Mem{Sent: *r.Will, Held: *r.Now, Put: s.Memory[r.Key].Put}
			case "forget":
				delete(s.Memory, r.Key)
			default:
				s.Preview[r.Key] = r
			}
		}
	case "compare":
		var rows []push.CompareRow
		if err := json.Unmarshal(encoded, &rows); err != nil {
			return push.SendAnswer{}, err
		}
		for _, r := range rows {
			s.Differences[r.Key] = r
		}
	case "push":
		var rows []push.WrittenRow
		if err := json.Unmarshal(encoded, &rows); err != nil {
			return push.SendAnswer{}, err
		}
		if body.Table >= len(s.Parts()) {
			return push.SendAnswer{}, fmt.Errorf("no part %d", body.Table)
		}
		if s.oneTransaction() {
			// Taken only at the end: committed, or for a rehearsal rolled back.
			s.pending = append(s.pending, page{table: body.Table, written: rows})
		} else {
			// The database committed this batch: the store takes it at once.
			s.take(rows)
			s.Cursor = body.Last
		}
	case "push_undo":
		var rows []push.UndoneRow
		if err := json.Unmarshal(encoded, &rows); err != nil {
			return push.SendAnswer{}, err
		}
		if body.Table >= len(s.Parts()) {
			return push.SendAnswer{}, fmt.Errorf("no part %d", body.Table)
		}
		s.pending = append(s.pending, page{table: body.Table, undone: rows})
	}
	s.Page = body.Page
	return push.SendAnswer{Page: body.Page, Taken: true}, nil
}

// take keeps a write's outcomes in this part: its memory, how each row ended, and the record of what
// the write did to each key it wrote.
func (s *Store) take(rows []push.WrittenRow) {
	for _, r := range rows {
		was, had := s.Memory[r.Key]
		switch r.Outcome {
		case "written":
			// A row the preview found new is one this store put there.
			s.Memory[r.Key] = Mem{Sent: *r.Sent, Held: *r.Held, Put: was.Put || s.Preview[r.Key].Action == "new"}
		case "removed":
			delete(s.Memory, r.Key)
		}
		s.Outcomes[r.Key] = r
		if r.Outcome == "held" {
			continue
		}
		w := &Wrote{Held: r.Held, Set: r.Set, Before: r.Before, Whole: r.Whole, State: "done"}
		switch {
		case r.Did != nil:
			w.Did = *r.Did
		case r.Outcome == "removed" && r.Before != nil:
			w.Did = "deleted"
		case r.Outcome == "written" && s.Preview[r.Key].Action == "new":
			// An earlier data job's commit the store never heard of, as the store reads it: the preview
			// found no row, so that write inserted it.
			w.Did = "inserted"
		case r.Outcome == "written" && s.Preview[r.Key].Action == "changed" && s.Preview[r.Key].Before != nil:
			// It changed the row from what the preview read, in the columns the preview names.
			w.Did, w.Set, w.Before = "updated", s.Preview[r.Key].Changed, s.Preview[r.Key].Before
		}
		if had {
			w.Mem = &was
		}
		s.Wrote[r.Key] = w
	}
}

func (s *Store) End(_ context.Context, body push.EndBody) (push.EndAnswer, error) {
	s.Ends++
	if s.FailEnd == s.Ends {
		return push.EndAnswer{}, &pull.StoreError{Status: 503, Code: "internal", Message: "The store could not take this call just now."}
	}
	switch {
	case s.Kind == "push" && s.oneTransaction():
		parts := s.Parts()
		switch {
		case body.Committed && !s.Rehearse:
			for _, pg := range s.pending {
				parts[pg.table].take(pg.written)
			}
		case body.RolledBack && s.Rehearse:
			// Nothing stayed: the memory is as it was, and the rows make the manifest.
			for _, pg := range s.pending {
				for _, r := range pg.written {
					parts[pg.table].Manifest[r.Key] = r
				}
			}
			s.Restored = body.Restored
		default:
			return push.EndAnswer{}, &pull.StoreError{Status: 400, Code: "bad_request", Message: "A write in one transaction ends committed, and a rehearsal rolled back."}
		}
	case s.Kind == "push_undo":
		if !body.Committed {
			return push.EndAnswer{}, &pull.StoreError{Status: 400, Code: "bad_request", Message: "An undo ends committed."}
		}
		parts := s.Parts()
		s.Undone = make([]map[string]string, len(parts))
		s.UndoneWhy = make([]map[string]string, len(parts))
		for i := range s.Undone {
			s.Undone[i] = map[string]string{}
			s.UndoneWhy[i] = map[string]string{}
		}
		for _, pg := range s.pending {
			p := parts[pg.table]
			for _, r := range pg.undone {
				s.Undone[pg.table][r.Key] = r.Outcome
				if r.Outcome != "undone" {
					s.UndoneWhy[pg.table][r.Key] = r.Why
					continue
				}
				// The key's memory goes back to what it was before the write.
				w := p.Wrote[r.Key]
				if w.Mem == nil {
					delete(p.Memory, r.Key)
				} else {
					p.Memory[r.Key] = *w.Mem
				}
				w.State = "undone"
			}
		}
		s.Of.UndoneBy = s
	}
	s.pending = nil
	s.Ended = &body
	return push.EndAnswer{Finishing: true}, nil
}

func (s *Store) Fail(_ context.Context, body pull.FailBody) error {
	s.Failed = &body
	return nil
}

// Str is a value for a row.
func Str(v string) *string { return &v }

// Row is a row of values; "<null>" is NULL.
func Row(values ...string) []*string {
	out := make([]*string, len(values))
	for i, v := range values {
		if v != "<null>" {
			out[i] = Str(v)
		}
	}
	return out
}
