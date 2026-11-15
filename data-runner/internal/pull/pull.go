// Package pull is a data job of kind `pull`: a database's tables into a store, a page at a time,
// sending only the rows the store does not hold. The wire is the store gateway's: contract/pull/
// holds one example of each body and answer.
//
// For each table the runner reads the store's memory of the table (each row's `_key` and `_hash`),
// reads every row of the database's table, and sends only the rows that differ, then the keys the
// database no longer has. Nothing is ordered: the store's hashes go into a map, so the database
// never sorts for a pull, and a different collation of its keys cannot make rows look changed.
//
// A pull that stops goes on: its successor reads the hashes the store holds now, which include
// every page it took, so it sends only what is still missing, under the store's next page number.
package pull

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
)

// waitPoll is how often the runner asks whether the store has started this job.
const waitPoll = 2 * time.Second

// Rows reads a table's rows.
type Rows interface {
	// Next moves to the next row; false at the end or on an error.
	Next() bool
	// Values is the row's values as text, nil for NULL. The runner may keep and change the slice.
	Values() ([]*string, error)
	Err() error
	Close() error
}

// Database is the database's side of a pull.
type Database interface {
	// Describe reads a table's columns in order and its primary key's columns in key order.
	Describe(ctx context.Context, table Source) ([]engine.Column, []string, error)
	// Read reads the table's rows, in no order.
	Read(ctx context.Context, table Source, columns []engine.Column) (Rows, error)
}

// Deps are what a pull uses, so tests can replace each.
type Deps struct {
	Store    Store
	Database Database
	// Classify turns a database error into the job's error, saying what it was doing.
	Classify func(err error, doing string) *job.Error
	Now      func() time.Time
	Sleep    func(ctx context.Context, d time.Duration) error
	Logf     func(format string, args ...any)
}

// runState is one pull under way.
type runState struct {
	Deps
}

// Run does the pull and answers what it did of each table, or the job's error.
func Run(ctx context.Context, d Deps) ([]job.PulledTable, *job.Error) {
	r := &runState{Deps: d}
	return r.run(ctx)
}

func (r *runState) run(ctx context.Context) ([]job.PulledTable, *job.Error) {
	state, failure := r.waitUntilTaking(ctx)
	if failure != nil {
		return nil, failure
	}
	done := make([]job.PulledTable, 0, len(state.Tables))
	if state.State != "taking" {
		// Every table was sent by an earlier data job: the store is finishing, or has.
		return done, nil
	}
	for i, table := range state.Tables {
		if table.Ended {
			r.Logf("%s: ended in an earlier data job", table.Source)
			continue
		}
		result, failure := r.pullTable(ctx, i, table, state.Limits)
		if failure != nil {
			return nil, failure
		}
		done = append(done, result)
	}
	return done, nil
}

func (r *runState) waitUntilTaking(ctx context.Context) (State, *job.Error) {
	for {
		state, err := r.Store.State(ctx)
		if err != nil {
			return State{}, r.storeFailure(ctx, err, "read where the pull stands")
		}
		switch state.State {
		case "taking", "finishing", "done":
			return state, nil
		case "waiting":
			r.Logf("the store runs another job first")
			if err := r.Sleep(ctx, waitPoll); err != nil {
				return State{}, job.Fail("deadline", "The job reached its deadline while the store ran another job.")
			}
		default:
			why := "The store ended this pull."
			if state.Error != nil && *state.Error != "" {
				why = *state.Error
			}
			return State{}, job.Fail("store", "%s", why)
		}
	}
}

func (r *runState) storeFailure(ctx context.Context, err error, doing string) *job.Error {
	if KeyRefused(err) {
		return job.Fail("store", "A newer data job took this pull over.")
	}
	if words := AtWriteLimit(err); words != "" {
		return job.Fail("store_limit", "%s", words)
	}
	if ctx.Err() != nil {
		return job.Fail("deadline", "The job reached its deadline while it tried to %s.", doing)
	}
	return job.Fail("store", "Could not %s: %s", doing, FirstLine(err.Error()))
}

// FirstLine is an error's first line, at most 300 bytes, cut on a character's boundary.
func FirstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	if len(s) > 300 {
		at := 300
		for at > 0 && !utf8.RuneStart(s[at]) {
			at--
		}
		s = s[:at] + "…"
	}
	return s
}

// memory is what the store holds of a table: `_key` to its 64-bit hash. A row the database still has
// comes out of it as it is read, so what stays is what the database no longer has.
type memory map[string]uint64

func (r *runState) readMemory(ctx context.Context, table int, limits Limits, source Source) (memory, *job.Error) {
	m := memory{}
	var after *string
	for {
		answer, err := r.Store.Hashes(ctx, HashesBody{Table: table, After: after, Limit: limits.HashRows})
		if err != nil {
			return nil, r.storeFailure(ctx, err, "read what the store holds of "+source.String())
		}
		for _, pair := range answer.Hashes {
			h, err := strconv.ParseUint(pair[1], 16, 64)
			if err != nil {
				return nil, job.Fail("store", "The store holds a hash this runner cannot read (%s).", pair[1])
			}
			m[pair[0]] = h
		}
		if answer.Next == nil {
			return m, nil
		}
		after = answer.Next
	}
}

// KeyText is a row's `_key` from its key columns' values: the value's text for a one-column key,
// a JSON array of the texts for one of several.
func KeyText(values []*string, at []int) string {
	if len(at) == 1 {
		if v := values[at[0]]; v != nil {
			return *v
		}
		return ""
	}
	parts := make([]*string, len(at))
	for i, a := range at {
		parts[i] = values[a]
	}
	return string(mustJSON(parts))
}

func mustJSON(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return bytes.TrimRight(b.Bytes(), "\n")
}

// FitRow cuts a row's values so their JSON holds at most limit bytes (a page's body is JSON, and a
// store keeps at most 2 MB in a row): every value keeps the same most it may, the longest the row
// can keep. Answers how many were cut. The cut is on a character's boundary. The row's hash reads
// the values before they are cut, so a change past the cut is still seen.
func FitRow(values []*string, limit int) int64 {
	// A byte is at most six in JSON, so most rows need no measuring.
	if rawBytes(values)*6 <= limit {
		return 0
	}
	before := slices.Clone(values)
	for {
		size, total := len(mustJSON(values)), rawBytes(values)
		if size <= limit || total == 0 {
			break
		}
		// The escapes take the same share of what stays, near enough; measured again until it fits.
		cutValues(values, total*limit/size)
	}
	var cut int64
	for i := range values {
		if values[i] != before[i] {
			cut++
		}
	}
	return cut
}

func rawBytes(values []*string) int {
	total := 0
	for _, v := range values {
		if v != nil {
			total += len(*v)
		}
	}
	return total
}

// cutValues cuts the longest values so the row's bytes come to at most budget.
func cutValues(values []*string, budget int) {
	lengths := make([]int, 0, len(values))
	for _, v := range values {
		if v != nil {
			lengths = append(lengths, len(*v))
		}
	}
	slices.Sort(lengths)
	limitEach := 0
	for i, n := range lengths {
		share := budget / (len(lengths) - i)
		if n > share {
			limitEach = share
			break
		}
		budget -= n
	}
	for i, v := range values {
		if v == nil || len(*v) <= limitEach {
			continue
		}
		at := limitEach
		for at > 0 && !utf8.RuneStart((*v)[at]) {
			at--
		}
		kept := (*v)[:at]
		values[i] = &kept
	}
}

// page collects a table's next rows, as JSON.
type page struct {
	buf  bytes.Buffer
	rows int
}

func (p *page) add(key, hash string, values []*string) {
	row := make([]*string, 0, len(values)+2)
	row = append(row, &key, &hash)
	row = append(row, values...)
	if p.rows > 0 {
		p.buf.WriteByte(',')
	}
	p.buf.Write(mustJSON(row))
	p.rows++
}

func (p *page) full(limits Limits) bool {
	return p.rows >= limits.PageRows || p.buf.Len() >= limits.PageBytes
}

func (p *page) reset() {
	p.buf.Reset()
	p.rows = 0
}

func (r *runState) pullTable(ctx context.Context, index int, table TableState, limits Limits) (job.PulledTable, *job.Error) {
	start := r.Now()
	source := table.Source
	columns, key, err := r.Database.Describe(ctx, source)
	if err != nil {
		return job.PulledTable{}, r.Classify(err, "read the columns of "+source.String())
	}
	if len(columns) == 0 {
		return job.PulledTable{}, job.Fail("database", "%s has no columns this login may read.", source)
	}
	begin, err := r.Store.Begin(ctx, BeginBody{Table: index, Columns: columns, Key: key})
	if err != nil {
		return job.PulledTable{}, r.storeFailure(ctx, err, "begin "+source.String())
	}
	r.Logf("%s: %d columns, key of %d, the store writes it as %s (page %d)", source, len(columns), len(key), begin.Mode, begin.Page)
	held := memory{}
	if begin.Mode == "change" || begin.Page > 0 {
		var failure *job.Error
		if held, failure = r.readMemory(ctx, index, limits, source); failure != nil {
			return job.PulledTable{}, failure
		}
		r.Logf("%s: the store holds %d rows", source, len(held))
	}
	keyAt, failure := keyPositions(columns, key, source)
	if failure != nil {
		return job.PulledTable{}, failure
	}
	rows, err := r.Database.Read(ctx, source, columns)
	if err != nil {
		return job.PulledTable{}, r.Classify(err, "read "+source.String())
	}
	defer rows.Close()

	result := job.PulledTable{Source: source.String(), Into: table.Into, Mode: begin.Mode}
	number := begin.Page
	var current page
	repeats := map[uint64]int{}
	send := func(rowsJSON []byte, removed []string) *job.Error {
		number++
		answer, err := r.Store.Page(ctx, index, number, rowsJSON, removed)
		if err != nil {
			return r.storeFailure(ctx, err, fmt.Sprintf("send page %d of %s", number, source))
		}
		if !answer.Taken {
			r.Logf("%s: page %d was taken before", source, number)
		}
		result.Pages++
		return nil
	}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return job.PulledTable{}, r.Classify(err, "read a row of "+source.String())
		}
		result.Read++
		hash := RowHash64(values)
		var rowKey string
		if len(keyAt) > 0 {
			rowKey = KeyText(values, keyAt)
		} else {
			repeats[hash]++
			rowKey = "h:" + HashText(hash)
			if n := repeats[hash]; n > 1 {
				rowKey += "#" + strconv.Itoa(n)
			}
		}
		if stored, ok := held[rowKey]; ok {
			delete(held, rowKey)
			if stored == hash {
				continue
			}
		}
		result.Cut += FitRow(values, limits.RowBytes)
		current.add(rowKey, HashText(hash), values)
		result.Sent++
		if current.full(limits) {
			if failure := send(current.buf.Bytes(), nil); failure != nil {
				return job.PulledTable{}, failure
			}
			current.reset()
		}
	}
	if err := rows.Err(); err != nil {
		return job.PulledTable{}, r.Classify(err, "read "+source.String())
	}
	if current.rows > 0 {
		if failure := send(current.buf.Bytes(), nil); failure != nil {
			return job.PulledTable{}, failure
		}
		current.reset()
	}
	// What the database no longer has.
	removed := make([]string, 0, len(held))
	for k := range held {
		removed = append(removed, k)
	}
	slices.Sort(removed)
	result.Removed = int64(len(removed))
	for len(removed) > 0 {
		n := removedPage(removed, limits)
		if failure := send(nil, removed[:n]); failure != nil {
			return job.PulledTable{}, failure
		}
		removed = removed[n:]
	}
	if _, err := r.Store.End(ctx, EndBody{Table: index, Read: result.Read, Cut: result.Cut}); err != nil {
		return job.PulledTable{}, r.storeFailure(ctx, err, "end "+source.String())
	}
	result.MS = r.Now().Sub(start).Milliseconds()
	r.Logf("%s: read %d rows, sent %d, removed %d, in %d pages", source, result.Read, result.Sent, result.Removed, result.Pages)
	return result, nil
}

// removedPage is how many of the keys the next page of removals holds: a page's count of them, and
// no more of their JSON than a page's bytes.
func removedPage(removed []string, limits Limits) int {
	size := 0
	for n, key := range removed {
		size += len(mustJSON(key)) + 1
		if n >= limits.Removed || (n > 0 && size > limits.PageBytes) {
			return n
		}
	}
	return len(removed)
}

// keyPositions are where the key's columns are among the table's.
func keyPositions(columns []engine.Column, key []string, source Source) ([]int, *job.Error) {
	at := make([]int, len(key))
	for i, k := range key {
		found := false
		for j, c := range columns {
			if c.Name == k {
				at[i] = j
				found = true
				break
			}
		}
		if !found {
			return nil, job.Fail("database", "%s's key names the column %s, which this login cannot read.", source, k)
		}
	}
	return at, nil
}
