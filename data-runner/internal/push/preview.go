package push

// A push's preview and a compare: both read the store's table a page at a time and the database's
// rows of each page's keys, then the database's rows of the keys the store wrote before that its table
// no longer holds. A preview says, for each key, what a write would do; a compare, how the two sides
// differ.

import (
	"context"
	"hash/fnv"
	"slices"
	"sort"
	"strings"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/pull"
)

// begun is a preview's or a compare's start: the database's table, the job's columns, where its key's
// columns are among them, the columns a new row needs that the store's table lacks, what the store
// wrote before, and the table's rows.
type begun struct {
	target     Table
	cols       []engine.Column
	keyAt      []int
	key        []string
	missing    []string
	memory     map[string]memo
	targetRows int64
	// claimed are the database's rows the store's keys found, or would put there, by a hash of their
	// key as the column kinds read it, each with a hash of the store key's text that found it.
	claimed map[uint64]uint64
}

// keyHash is a key's hash, for knowing it again without keeping its text.
func keyHash(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}

func (r *runState) begin(ctx context.Context, st State) (*begun, *job.Error) {
	target := st.Target
	described, err := r.Database.Describe(ctx, target)
	if err != nil {
		return nil, r.Classify(err, "read the columns of "+target.String())
	}
	if len(described.Columns) == 0 {
		return nil, job.Fail("database", "%s has no columns this login may read.", target)
	}
	body := BeginBody{Columns: make([]BeginColumn, len(described.Columns)), PrimaryKey: described.Key}
	for i, c := range described.Columns {
		body.Columns[i] = BeginColumn{Name: c.Name, Type: c.Type, Required: slices.Contains(described.Required, c.Name)}
	}
	answer, err := r.Store.Begin(ctx, body)
	if err != nil {
		return nil, r.storeFailure(ctx, err, "begin "+target.String())
	}
	cols, keyAt, failure := jobColumns(described.Columns, answer.Columns, answer.Key, target)
	if failure != nil {
		return nil, failure
	}
	memory, failure := r.readMemory(ctx, st.Limits)
	if failure != nil {
		return nil, failure
	}
	count, err := r.Database.Count(ctx, target)
	if err != nil {
		return nil, r.Classify(err, "count the rows of "+target.String())
	}
	r.Logf("%s: %d columns, key of %d, %d rows; the store's table has %d, its memory %d", target, len(cols), len(keyAt), count, answer.Rows, len(memory))
	return &begun{target: target, cols: cols, keyAt: keyAt, key: answer.Key, missing: answer.Missing, memory: memory, targetRows: count, claimed: map[uint64]uint64{}}, nil
}

// rowsOf reads the database's rows of these keys, indexed by key.
func (r *runState) rowsOf(ctx context.Context, b *begun, keys [][]*string) (*byKey, *job.Error) {
	rows, err := r.Database.Rows(ctx, b.target, b.cols, b.keyAt, keys)
	if err != nil {
		return nil, r.Classify(err, "read rows of "+b.target.String()+" by key")
	}
	return indexRows(r.Engine, b.cols, b.keyAt, rows, keys, b.target, b.key)
}

// claim notes the database's row a store key found (`db`), or the row it would put there (nil `db`:
// its own key). Two store keys of one row are keys the database reads as one ("7" and "007" in a
// number's column, "BP-1" and "bp-1" where a collation ignores case): neither a preview nor a compare
// can say which of them the row is, so the job fails, naming no key.
func (b *begun) claim(eng, key string, store, db []*string) *job.Error {
	row := db
	if row == nil {
		row = store
	}
	at, text := keyHash(engine.CanonKey(eng, b.cols, row, b.keyAt)), keyHash(key)
	if was, ok := b.claimed[at]; ok && was != text {
		return job.Fail("store", "Two of the store's keys name one row of %s, as the database reads them (%s): make them one key, or name a key that tells them apart.", b.target, strings.Join(b.key, ", "))
	}
	b.claimed[at] = text
	return nil
}

// scan hands `visit` each row of the store's table with the database's row of its key (nil for none),
// and `paged` (when given) each page's end, then hands `left` each key of the store's memory its table
// does not hold, with the database's row. `kept` says a store key found that row under other text
// ('42.0' where the memory holds '42'): the store holds it still.
func (r *runState) scan(ctx context.Context, st State, b *begun, visit func(key string, store, db []*string) *job.Error, paged func() *job.Error, left func(key string, m memo, db []*string, kept bool) *job.Error) *job.Error {
	var after *string
	for {
		answer, err := r.Store.Read(ctx, ReadBody{Part: "source", After: after, Limit: st.Limits.ReadRows})
		if err != nil {
			return r.storeFailure(ctx, err, "read the store's table")
		}
		rows, err := decodeRows(answer.Rows, len(b.cols))
		if err != nil {
			return job.Fail("store", "The store answered its table's rows in a shape this runner cannot read: %s.", err)
		}
		if len(rows) > 0 {
			found, failure := r.rowsOf(ctx, b, keysOf(rows, b.keyAt))
			if failure != nil {
				return failure
			}
			for _, row := range rows {
				r.counts.Read++
				key := pull.KeyText(row, b.keyAt)
				db := found.find(row)
				if failure := b.claim(r.Engine, key, row, db); failure != nil {
					return failure
				}
				if failure := visit(key, row, db); failure != nil {
					return failure
				}
				delete(b.memory, key)
			}
			if paged != nil {
				if failure := paged(); failure != nil {
					return failure
				}
			}
		}
		if answer.Next == nil {
			break
		}
		after = answer.Next
	}
	keys := make([]string, 0, len(b.memory))
	for k := range b.memory {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for len(keys) > 0 {
		n := min(len(keys), st.Limits.ReadRows)
		chunk := keys[:n]
		keys = keys[n:]
		values := make([][]*string, len(chunk))
		for i, k := range chunk {
			v, err := keyValues(k, len(b.keyAt))
			if err != nil {
				return job.Fail("store", "The store's memory holds a key this runner cannot read (%s).", err)
			}
			values[i] = v
		}
		found, failure := r.rowsOf(ctx, b, values)
		if failure != nil {
			return failure
		}
		for i, k := range chunk {
			db := found.find(widen(values[i], b.keyAt, len(b.cols)))
			kept := false
			if db != nil {
				_, kept = b.claimed[keyHash(engine.CanonKey(r.Engine, b.cols, db, b.keyAt))]
			}
			if failure := left(k, b.memory[k], db, kept); failure != nil {
				return failure
			}
		}
	}
	return nil
}

// preview says, for each key, what writing the store's table into the database's would do, and sends
// the store a row for each key where something would happen. A page's rows wait for its links to be
// counted before they go.
func (r *runState) preview(ctx context.Context, st State) *job.Error {
	b, failure := r.begin(ctx, st)
	if failure != nil {
		return failure
	}
	links, failure := r.linksOf(ctx, st.Links, b)
	if failure != nil {
		return failure
	}
	overwrite := st.TheirEdits == "overwrite"
	send := &sender{r: r, limits: st.Limits}
	var page []*PreviewRow
	keep := func(row PreviewRow) *job.Error {
		page = append(page, &row)
		return nil
	}
	visit := func(key string, store, db []*string) *job.Error {
		will := pull.RowHash(store)
		m, wrote := b.memory[key]
		if db == nil {
			if wrote && !overwrite {
				return keep(PreviewRow{Key: key, Action: "held", Will: &will, Why: strp("removed_there"), After: store})
			}
			if len(b.missing) > 0 {
				return job.Fail("database", "%s needs a value in %s for each new row, and the store's table has no such column.", b.target, strings.Join(b.missing, ", "))
			}
			if failure := r.writable(b.cols, store, nil); failure != nil {
				return failure
			}
			return keep(PreviewRow{Key: key, Action: "new", Will: &will, After: store})
		}
		now := pull.RowHash(db)
		if wrote && now == m.held && will == m.sent {
			// What our last write left there, and the store has not changed it since.
			r.counts.Same++
			return nil
		}
		diff := differing(r.Engine, b.cols, b.keyAt, store, db)
		switch {
		case len(diff) == 0:
			// The database holds the store's values already: the memory notes them as there, so a
			// later edit there is held, and never as put there by this store.
			r.counts.Same++
			return keep(PreviewRow{Key: key, Action: "adopt", Now: &now, Will: &will})
		case wrote && now != m.held && !overwrite:
			return keep(PreviewRow{Key: key, Action: "held", Now: &now, Will: &will, Why: strp("changed_there"), Changed: diff, Before: db, After: store})
		}
		if failure := r.writable(b.cols, store, diff); failure != nil {
			return failure
		}
		return keep(PreviewRow{Key: key, Action: "changed", Now: &now, Will: &will, Changed: diff, Before: db, After: store})
	}
	paged := func() *job.Error {
		if failure := r.checkLinks(ctx, links, b.cols, page); failure != nil {
			return failure
		}
		for _, row := range page {
			if failure := send.add(ctx, *row); failure != nil {
				return failure
			}
		}
		page = page[:0]
		return nil
	}
	left := func(key string, m memo, db []*string, kept bool) *job.Error {
		// A row gone from the database is forgotten, and so is one this store did not put there (it
		// found the row already holding its values) and one the store holds under other text: a write
		// removes only a row this store put there.
		if db == nil || !m.put || kept {
			return send.add(ctx, PreviewRow{Key: key, Action: "forget"})
		}
		// Unless asked to remove, a row this store put there stays, and so does its memory: the
		// store's table may be a part of what it writes (a week's file, a town's rows).
		if !st.Removes {
			return nil
		}
		now := pull.RowHash(db)
		if now != m.held && !overwrite {
			return send.add(ctx, PreviewRow{Key: key, Action: "held", Now: &now, Why: strp("changed_there"), Before: db})
		}
		return send.add(ctx, PreviewRow{Key: key, Action: "removed", Now: &now, Before: db})
	}
	if failure := r.scan(ctx, st, b, visit, paged, left); failure != nil {
		return failure
	}
	if failure := send.flush(ctx); failure != nil {
		return failure
	}
	r.counts.TargetRows = b.targetRows
	end := EndBody{Read: i64(r.counts.Read), TargetRows: i64(b.targetRows), Same: i64(r.counts.Same)}
	for _, l := range links {
		end.Links = append(end.Links, l.count)
		r.Logf("link %s to %s: %d linked, %d unlinked, %d empty", l.count.Column, l.count.To, l.count.Linked, l.count.Unlinked, l.count.Empty)
	}
	r.counts.Links = end.Links
	if _, err := r.Store.End(ctx, end); err != nil {
		return r.storeFailure(ctx, err, "end the preview")
	}
	r.Logf("preview: read %d rows, sent %d, %d the same", r.counts.Read, r.counts.Sent, r.counts.Same)
	return nil
}

// writable refuses a value a write would bind that a pull named instead of keeping it (a binary too
// long to keep): in every column of a new row (`only` nil), or in the columns a change sets.
func (r *runState) writable(cols []engine.Column, values []*string, only []string) *job.Error {
	for i, c := range cols {
		if only != nil && !slices.Contains(only, c.Name) {
			continue
		}
		if engine.TooLongToWrite(r.Engine, c, values[i]) {
			return job.Fail("database", "The store's table holds a value of %s too long to have been kept whole, so it cannot be written back.", c.Name)
		}
	}
	return nil
}

// compare sends the store a row for each key whose rows differ: the store's alone, the database's
// alone (of the keys the store put there), or both with values that differ.
func (r *runState) compare(ctx context.Context, st State) *job.Error {
	b, failure := r.begin(ctx, st)
	if failure != nil {
		return failure
	}
	send := &sender{r: r, limits: st.Limits}
	var inScope int64
	visit := func(key string, store, db []*string) *job.Error {
		if db == nil {
			return send.add(ctx, CompareRow{Key: key, Difference: "store_only", Store: store})
		}
		inScope++
		diff := differing(r.Engine, b.cols, b.keyAt, store, db)
		if len(diff) == 0 {
			r.counts.Same++
			return nil
		}
		return send.add(ctx, CompareRow{Key: key, Difference: "differs", Columns: diff, Store: store, Database: db})
	}
	left := func(key string, m memo, db []*string, kept bool) *job.Error {
		// A row this store did not put there is one of the table's other rows; one the store holds
		// under other text was compared already.
		if db == nil || !m.put || kept {
			return nil
		}
		inScope++
		return send.add(ctx, CompareRow{Key: key, Difference: "database_only", Database: db})
	}
	if failure := r.scan(ctx, st, b, visit, nil, left); failure != nil {
		return failure
	}
	if failure := send.flush(ctx); failure != nil {
		return failure
	}
	r.counts.TargetRows = b.targetRows
	r.counts.OtherRows = max(0, b.targetRows-inScope)
	if _, err := r.Store.End(ctx, EndBody{Read: i64(r.counts.Read), TargetRows: i64(b.targetRows), Same: i64(r.counts.Same), OtherRows: i64(r.counts.OtherRows)}); err != nil {
		return r.storeFailure(ctx, err, "end the compare")
	}
	r.Logf("compare: read %d rows, sent %d differences, %d the same, %d other rows", r.counts.Read, r.counts.Sent, r.counts.Same, r.counts.OtherRows)
	return nil
}
