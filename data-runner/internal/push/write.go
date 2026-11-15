package push

// A push: a preview's rows written into the database's table, a batch at a time. Its rows are read by
// key with locks, each is written only while it still holds what the preview read (or is already what
// the write would make it, from an earlier data job whose commit the store never heard of), and the
// written rows are read back. A row the write updated or removed goes to the store with what the
// database held before it (its `before`), so an undo can put it back.
//
// A write of one preview commits each batch as its own transaction, and only then does the store hear
// how each row ended, as one page; its cursor moves past the batch's last key, so a data job that stops
// anywhere before that leaves the batch to its successor.
//
// A write of several previews, and a rehearsal, is one transaction for the whole write (writeAll):
// every preview's new and changed rows in the order given, then every preview's removed rows in the
// reverse order, a batch at a time. The store keeps each batch's page and applies nothing until the
// end: a write commits, then ends `committed`; a rehearsal rolls back, reads every row it wrote again,
// and ends `rolledBack` with how many hold exactly what they held before. A data job that stops before
// the end begins the job again (`rows/begin` with `again`): the database rolled its part back.

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/pull"
)

// writePart is a part of a write or an undo as the database's table reads it: its columns, in the
// store's order, where its key's columns are among them, the columns a new row needs a value in that
// are not among them, and the table's other columns, which the write never writes.
type writePart struct {
	Part
	// index is the part's place in the job, as a read and a page name it.
	index   int
	cols    []engine.Column
	keyAt   []int
	missing []string
	// extra are the table's columns the write does not write, in the table's order. An undo deletes a
	// row the write inserted only while they hold what they held right after the insert, and inserts a
	// row it removed again only when they held nothing: their values are not the write's to take.
	extra []engine.Column
}

// pageBytesMax is the most bytes of JSON one of a write's or an undo's rows may take as it goes to the
// store: the store's gateway takes a page of at most 4 MiB, and a row bigger than that could never be
// recorded. A batch with such a row stops before its database commits it.
const pageBytesMax = 3_500_000

// describeParts reads every part's table. A one-transaction job reads them all before its transaction
// begins: while it is open, the job's one connection is the transaction's.
func (r *runState) describeParts(ctx context.Context, parts []Part) ([]*writePart, *job.Error) {
	out := make([]*writePart, len(parts))
	for i, p := range parts {
		described, err := r.Database.Describe(ctx, p.Target)
		if err != nil {
			return nil, r.Classify(err, "read the columns of "+p.Target.String())
		}
		cols, keyAt, failure := jobColumns(described.Columns, p.Columns, p.Key, p.Target)
		if failure != nil {
			return nil, failure
		}
		var missing []string
		for _, name := range described.Required {
			if !slices.ContainsFunc(cols, func(c engine.Column) bool { return c.Name == name }) {
				missing = append(missing, name)
			}
		}
		var extra []engine.Column
		for _, c := range described.Columns {
			if !slices.ContainsFunc(cols, func(own engine.Column) bool { return own.Name == c.Name }) {
				extra = append(extra, c)
			}
		}
		out[i] = &writePart{Part: p, index: i, cols: cols, keyAt: keyAt, missing: missing, extra: extra}
	}
	return out, nil
}

// otherColumns reads, inside tx, the hash of the other columns (`extra`) of each row of keys, by the
// row's place in keys; a row not found has none. Nil when the table has no other columns.
func (r *runState) otherColumns(ctx context.Context, tx Batch, p *writePart, keys [][]*string, lock bool) (map[int]string, *job.Error) {
	if len(p.extra) == 0 || len(keys) == 0 {
		return nil, nil
	}
	cols := make([]engine.Column, 0, len(p.keyAt)+len(p.extra))
	keyAt := make([]int, len(p.keyAt))
	for i, at := range p.keyAt {
		cols = append(cols, p.cols[at])
		keyAt[i] = i
	}
	cols = append(cols, p.extra...)
	rows, err := tx.Rows(ctx, p.Target, cols, keyAt, keys, lock)
	if err != nil {
		return nil, r.Classify(err, "read the other columns of "+p.Target.String())
	}
	found, failure := indexRows(r.Engine, cols, keyAt, rows, keys, p.Target, p.Key)
	if failure != nil {
		return nil, failure
	}
	out := make(map[int]string, len(keys))
	for i, k := range keys {
		if row := found.find(widen(k, keyAt, len(cols))); row != nil {
			out[i] = wholeHash(p.extra, row[len(keyAt):])
		}
	}
	return out, nil
}

// wholeHash is the hash of a row's other columns, by name and value: a column added, dropped or
// renamed since makes another hash.
func wholeHash(extra []engine.Column, values []*string) string {
	named := make([]*string, 0, 2*len(extra))
	for i, c := range extra {
		name := c.Name
		named = append(named, &name, values[i])
	}
	return pull.RowHash(named)
}

// emptyWhole is the hash of other columns that hold nothing at all.
func emptyWhole(extra []engine.Column) string {
	return wholeHash(extra, make([]*string, len(extra)))
}

// page is some of a batch's outcomes as one page, and the key of its last row.
type page struct {
	rows []any
	last string
}

// pagesOf splits a batch's outcomes into pages of at most limits' rows and bytes of JSON (a page of one
// row may be bigger), in their order; it fails, naming no value, when one row is too big for any page.
func pagesOf[T any](rows []T, keyOf func(T) string, limits Limits, t Table) ([]page, *job.Error) {
	var out []page
	var cur page
	bytes := 0
	for _, row := range rows {
		encoded, err := json.Marshal(row)
		if err != nil {
			return nil, job.Fail("internal", "A row could not be written as JSON: %s", err)
		}
		if len(encoded) > pageBytesMax {
			return nil, job.Fail("store", "A row of %s takes %d bytes as it goes to the store, more than the %d one page may take: the store could not record it, so nothing of this batch is committed.", t, len(encoded), pageBytesMax)
		}
		if len(cur.rows) > 0 && (len(cur.rows) >= max(1, limits.SendRows) || bytes+len(encoded) > max(1, limits.SendBytes)) {
			out = append(out, cur)
			cur, bytes = page{}, 0
		}
		cur.rows = append(cur.rows, json.RawMessage(encoded))
		cur.last = keyOf(row)
		bytes += len(encoded) + 1
	}
	if len(cur.rows) > 0 {
		out = append(out, cur)
	}
	return out, nil
}

func writtenKey(o WrittenRow) string { return o.Key }
func undoneKey(o UndoneRow) string   { return o.Key }

// write writes one preview, each batch in a transaction of its own.
func (r *runState) write(ctx context.Context, st State) *job.Error {
	parts, failure := r.describeParts(ctx, st.parts()[:1])
	if failure != nil {
		return failure
	}
	p := parts[0]
	after := st.Cursor
	page := st.Page
	for {
		rows, next, failure := r.readWrites(ctx, p, after, "", st.Limits)
		if failure != nil {
			return failure
		}
		if len(rows) == 0 {
			break
		}
		tx, err := r.Database.Write(ctx)
		if err != nil {
			return r.Classify(err, "begin a transaction on "+p.Target.String())
		}
		done, failure := r.writeBatch(ctx, tx, p, rows, false)
		if failure != nil {
			_ = tx.Rollback()
			return failure
		}
		// The batch's outcomes go as pages the store can take, each row of them on one: a row too big
		// for any page stops the batch before its database commits it.
		pages, failure := pagesOf(done.outcomes, writtenKey, st.Limits, p.Target)
		if failure != nil {
			_ = tx.Rollback()
			return failure
		}
		if err := tx.Commit(); err != nil {
			return r.Classify(err, "commit the batch's transaction on "+p.Target.String())
		}
		r.counts.add(done.counts)
		for _, pg := range pages {
			page++
			taken, failure := r.sendPage(ctx, page, pg.rows, pg.last, p.index, "record a batch the database took")
			if failure != nil {
				return failure
			}
			if !taken {
				r.Logf("page %d was taken before", page)
			}
		}
		r.counts.Batches++
		last := rows[len(rows)-1].Key
		after = &last
		if next == nil {
			break
		}
	}
	if _, err := r.Store.End(ctx, EndBody{Batches: i64(r.counts.Batches)}); err != nil {
		return r.storeFailure(ctx, err, "end the write")
	}
	r.Logf("write: %d batches, %d inserted, %d updated, %d deleted, %d held", r.counts.Batches, r.counts.Inserted, r.counts.Updated, r.counts.Deleted, r.counts.Held)
	return nil
}

// writeAll writes every preview of the job in one transaction, and commits it, or for a rehearsal
// rolls it back.
func (r *runState) writeAll(ctx context.Context, st State) *job.Error {
	parts, failure := r.describeParts(ctx, st.parts())
	if failure != nil {
		return failure
	}
	what, whole := "write", "write in one transaction"
	if st.Rehearse {
		what, whole = "rehearsal", "rehearsal"
	}
	if failure := r.rollsBack(ctx, parts, whole); failure != nil {
		return failure
	}
	begun, err := r.Store.BeginAgain(ctx)
	if err != nil {
		return r.storeFailure(ctx, err, "begin the "+what+" again")
	}
	r.Logf("%s: %d rows of %d tables, in one transaction", what, begun.Rows, len(parts))
	tx, err := r.Database.Write(ctx)
	if err != nil {
		return r.Classify(err, "begin the "+what+"'s transaction")
	}
	open := true
	defer func() {
		if open {
			_ = tx.Rollback()
		}
	}()
	w := &oneWrite{tx: tx, rehearse: st.Rehearse, touched: make([][]touch, len(parts))}
	if len(parts) == 1 {
		// One preview goes in the order of its real write, a batch at a time in key order, each with
		// its removals: a rehearsal of it meets what that write would.
		if failure := r.writeRows(ctx, w, parts[0], "", st.Limits); failure != nil {
			return failure
		}
	} else {
		// A parent's rows go in before its child's, and a child's are removed before its parent's:
		// every part's puts in the order given, then its removals in the reverse order.
		for _, p := range parts {
			if failure := r.writeRows(ctx, w, p, "puts", st.Limits); failure != nil {
				return failure
			}
		}
		for i := len(parts) - 1; i >= 0; i-- {
			if failure := r.writeRows(ctx, w, parts[i], "removals", st.Limits); failure != nil {
				return failure
			}
		}
	}
	if st.Rehearse {
		// What the database checks only at a commit it checks now: a rehearsal never commits.
		if err := tx.CheckDeferred(ctx); err != nil {
			return r.Classify(err, "check what the database checks at a commit, before the rehearsal's rollback")
		}
	}
	end := EndBody{Batches: i64(w.batches)}
	open = false
	if st.Rehearse {
		if err := tx.Rollback(); err != nil {
			return r.Classify(err, "roll back the rehearsal's transaction")
		}
		restored, failure := r.restored(ctx, parts, w.touched, st.Limits)
		if failure != nil {
			return failure
		}
		end.RolledBack, end.Restored = true, i64(restored)
		r.counts.RolledBack, r.counts.Restored = true, restored
	} else {
		if err := tx.Commit(); err != nil {
			return r.Classify(err, "commit the write's transaction")
		}
		end.Committed = true
	}
	r.counts.add(w.counts)
	r.counts.Batches = w.batches
	if _, err := r.Store.End(ctx, end); err != nil {
		return r.storeFailure(ctx, err, "end the "+what)
	}
	if st.Rehearse {
		touched := 0
		for _, t := range w.touched {
			touched += len(t)
		}
		r.Logf("rehearsal: %d batches, %d inserted, %d updated, %d deleted, %d held, rolled back; %d of %d rows read back as they were", w.batches, w.counts.Inserted, w.counts.Updated, w.counts.Deleted, w.counts.Held, r.counts.Restored, touched)
	} else {
		r.Logf("write: %d batches of %d tables, %d inserted, %d updated, %d deleted, %d held, committed", w.batches, len(parts), w.counts.Inserted, w.counts.Updated, w.counts.Deleted, w.counts.Held)
	}
	return nil
}

// rollsBack refuses a one-transaction job on a table whose changes do not roll back: MySQL's MyISAM
// keeps what each statement wrote whatever the transaction does, so a rehearsal would leave its rows
// written, and a write of several tables or an undo that stopped would leave a part of itself. It runs
// before the job's transaction begins, and before the store hears of the job.
func (r *runState) rollsBack(ctx context.Context, parts []*writePart, what string) *job.Error {
	for _, p := range parts {
		name, ok, err := r.Database.RollsBack(ctx, p.Target)
		if err != nil {
			return r.Classify(err, "read which engine keeps "+p.Target.String())
		}
		if ok {
			continue
		}
		if name == "" {
			return job.Fail("database", "MySQL names no engine that keeps %s (a view has none), so the runner cannot tell that a rollback takes back its changes, and starts no %s there.", p.Target, what)
		}
		return job.Fail("database", "%s is a %s table, whose changes MySQL cannot roll back: a %s there could leave rows written, so the runner starts none.", p.Target, name, what)
	}
	return nil
}

// oneWrite is a one-transaction write as it goes: its transaction, its pages and batches, what its
// batches did (counted into the job's at its end), and, for a rehearsal, the rows each part's batches
// wrote.
type oneWrite struct {
	tx       Batch
	rehearse bool
	page     int64
	batches  int64
	counts   Counts
	touched  [][]touch
}

// touch is a row a rehearsal wrote or removed (or found holding its new values already): its key, and
// the hash of what the database held there before it (had false: no row). A row it held is not one.
type touch struct {
	key    string
	had    bool
	before string
}

// writeRows writes a part's rows of one kind, puts or removals, a batch at a time.
func (r *runState) writeRows(ctx context.Context, w *oneWrite, p *writePart, only string, limits Limits) *job.Error {
	var after *string
	for {
		rows, next, failure := r.readWrites(ctx, p, after, only, limits)
		if failure != nil {
			return failure
		}
		if len(rows) == 0 {
			return nil
		}
		done, failure := r.writeBatch(ctx, w.tx, p, rows, w.rehearse)
		if failure != nil {
			return failure
		}
		pages, failure := pagesOf(done.outcomes, writtenKey, limits, p.Target)
		if failure != nil {
			return failure
		}
		w.counts.add(done.counts)
		w.touched[p.index] = append(w.touched[p.index], done.touched...)
		w.batches++
		for _, pg := range pages {
			w.page++
			if failure := r.sendPending(ctx, w.page, pg, p.index, "send a batch's outcomes"); failure != nil {
				return failure
			}
		}
		last := rows[len(rows)-1].Key
		after = &last
		if next == nil {
			return nil
		}
	}
}

// readWrites reads a batch of a part's rows to write, after `after`: every kind, or only puts or
// removals.
func (r *runState) readWrites(ctx context.Context, p *writePart, after *string, only string, limits Limits) ([]WriteRow, *string, *job.Error) {
	answer, err := r.Store.Read(ctx, ReadBody{Part: "write", After: after, Limit: limits.BatchRows, Table: p.index, Only: only})
	if err != nil {
		return nil, nil, r.storeFailure(ctx, err, "read the preview's rows to write")
	}
	rows := make([]WriteRow, len(answer.Rows))
	for i, raw := range answer.Rows {
		if err := json.Unmarshal(raw, &rows[i]); err != nil {
			return nil, nil, job.Fail("store", "The store answered the preview's rows in a shape this runner cannot read.")
		}
		// Every part's puts go before any part's removals: a row of the other kind would break that order.
		if (only == "puts" && rows[i].Action == "removed") || (only == "removals" && rows[i].Action != "removed") {
			asked := "the new and changed rows"
			if only == "removals" {
				asked = "the removed rows"
			}
			return nil, nil, job.Fail("store", "The store answered a %s row when asked for %s only.", rows[i].Action, asked)
		}
	}
	return rows, answer.Next, nil
}

// sendPage sends the store a batch's outcomes as page `page` of part `table`, and says whether the
// store took it now (false: it took it before).
func (r *runState) sendPage(ctx context.Context, page int64, rows []any, last string, table int, doing string) (bool, *job.Error) {
	answer, err := r.Store.Send(ctx, SendBody{Page: page, Rows: rows, Last: &last, Table: table})
	if err != nil {
		return false, r.storeFailure(ctx, err, doing)
	}
	return answer.Taken, nil
}

// sendPending sends a page of a one-transaction job (a write of several previews, a rehearsal, an
// undo), which the store keeps pending until the job's end. Begun again, the job's pages start over
// and only this data job may send them, so a page the store says it took before is this one: the
// client sent it again after its answer was lost.
func (r *runState) sendPending(ctx context.Context, n int64, pg page, table int, doing string) *job.Error {
	taken, failure := r.sendPage(ctx, n, pg.rows, pg.last, table, doing)
	if failure != nil {
		return failure
	}
	if !taken {
		r.Logf("page %d was taken before: its answer was lost, and it was sent again", n)
	}
	return nil
}

// update is a changed row's write: which row of the batch, and which columns it sets.
type update struct {
	at  int
	set []int
}

// batchDone is what a batch did: how each of its rows ended, its counts, and, for a rehearsal, the rows
// it touched.
type batchDone struct {
	outcomes []WrittenRow
	counts   Counts
	touched  []touch
}

// writeBatch writes one batch inside tx and answers how each of its rows ended. It neither commits
// nor rolls back: the caller does, and counts the batch once the database took it.
func (r *runState) writeBatch(ctx context.Context, tx Batch, p *writePart, rows []WriteRow, rehearse bool) (batchDone, *job.Error) {
	target, cols, keyAt := p.Target, p.cols, p.keyAt
	var done batchDone
	keys := make([][]*string, len(rows))
	for i, w := range rows {
		v, err := keyValues(w.Key, len(keyAt))
		if err != nil {
			return done, job.Fail("store", "The preview holds a key this runner cannot read (%s).", err)
		}
		keys[i] = v
		if (w.Action == "new" || w.Action == "changed") && len(w.Values) != len(cols) {
			return done, job.Fail("store", "The preview holds a row of %d values where the write has %d columns.", len(w.Values), len(cols))
		}
		if (w.Action == "changed" || w.Action == "removed") && w.Now == nil {
			return done, job.Fail("store", "The preview holds a row with no hash of what the database held.")
		}
	}
	current, err := tx.Rows(ctx, target, cols, keyAt, keys, true)
	if err != nil {
		return done, r.Classify(err, "read and lock the batch's rows of "+target.String())
	}
	found, failure := indexRows(r.Engine, cols, keyAt, current, keys, target, p.Key)
	if failure != nil {
		return done, failure
	}
	outcomes := make([]WrittenRow, len(rows))
	var inserts [][]*string
	var updates []update
	var deletes [][]*string
	// The removed rows, by their place in the batch, in the order of deletes.
	var deleting []int
	// The rows whose write is read back, by their place in the batch, and what each did there.
	var written []int
	did := make([]string, len(rows))
	sets := make([][]string, len(rows))
	befores := make([][]*string, len(rows))
	var touches []touch
	if rehearse {
		touches = make([]touch, len(rows))
	}
	for i, w := range rows {
		cur := found.find(widen(keys[i], keyAt, len(cols)))
		if rehearse {
			touches[i] = touch{key: w.Key, had: cur != nil}
			if cur != nil {
				touches[i].before = pull.RowHash(cur)
			}
		}
		heldRow := func(why string) WrittenRow {
			done.counts.Held++
			return WrittenRow{Key: w.Key, Outcome: "held", Why: strp(why)}
		}
		switch w.Action {
		case "new":
			switch {
			case cur == nil:
				if failure := r.writable(cols, w.Values, nil); failure != nil {
					return done, failure
				}
				inserts = append(inserts, w.Values)
				written = append(written, i)
				did[i] = "inserted"
				done.counts.Inserted++
			case sameRow(r.Engine, cols, w.Values, cur):
				// An earlier data job's commit the store never heard of: the preview found no row, so
				// that write inserted it, and an undo removes it.
				written = append(written, i)
				did[i] = "inserted"
				done.counts.Inserted++
			default:
				outcomes[i] = heldRow("appeared")
			}
		case "changed":
			switch {
			case cur == nil:
				outcomes[i] = heldRow("since_preview")
			case pull.RowHash(cur) == *w.Now:
				set := make([]int, 0, len(w.Changed))
				for _, name := range w.Changed {
					if at := slices.IndexFunc(cols, func(c engine.Column) bool { return c.Name == name }); at >= 0 && !slices.Contains(keyAt, at) && !slices.Contains(set, at) {
						set = append(set, at)
					}
				}
				// An update sets only the columns that differ, so a change that names none of the
				// write's columns is not one a preview made.
				if len(set) == 0 {
					return done, job.Fail("store", "The preview holds a change of a row that names none of the write's columns.")
				}
				if failure := r.writable(cols, w.Values, w.Changed); failure != nil {
					return done, failure
				}
				updates = append(updates, update{at: i, set: set})
				written = append(written, i)
				did[i] = "updated"
				sets[i] = make([]string, len(set))
				for j, at := range set {
					sets[i][j] = cols[at].Name
				}
				befores[i] = cur
				done.counts.Updated++
			case sameRow(r.Engine, cols, w.Values, cur):
				written = append(written, i)
				done.counts.Updated++
			default:
				outcomes[i] = heldRow("since_preview")
			}
		case "removed":
			switch {
			case cur == nil:
				// Gone already: an earlier data job's commit, or someone else's delete.
				outcomes[i] = WrittenRow{Key: w.Key, Outcome: "removed"}
				done.counts.Deleted++
			case pull.RowHash(cur) == *w.Now:
				deletes = append(deletes, keys[i])
				deleting = append(deleting, i)
				outcomes[i] = WrittenRow{Key: w.Key, Outcome: "removed", Before: cur}
				done.counts.Deleted++
			default:
				outcomes[i] = heldRow("since_preview")
			}
		default:
			return done, job.Fail("store", "The preview holds a row to %s, which a write does not do.", w.Action)
		}
	}
	// What an undo checks of the table's other columns: a rehearsal is never undone.
	whole := !rehearse && len(p.extra) > 0
	if whole && len(deleting) > 0 {
		// What they held before the delete: an undo inserts the row again only when they held nothing.
		got, failure := r.otherColumns(ctx, tx, p, deletes, false)
		if failure != nil {
			return done, failure
		}
		for j, i := range deleting {
			if h, ok := got[j]; ok {
				outcomes[i].Whole = strp(h)
			}
		}
	}
	if len(inserts) > 0 {
		if err := tx.Insert(ctx, target, cols, inserts); err != nil {
			return done, r.Classify(err, "insert the batch's new rows into "+target.String())
		}
	}
	for _, u := range updates {
		if err := tx.Update(ctx, target, cols, u.set, keyAt, rows[u.at].Values); err != nil {
			return done, r.Classify(err, "update a row of "+target.String())
		}
	}
	if len(deletes) > 0 {
		if err := tx.Delete(ctx, target, cols, keyAt, deletes); err != nil {
			return done, r.Classify(err, "delete the batch's removed rows from "+target.String())
		}
	}
	if len(written) > 0 {
		back := make([][]*string, len(written))
		for j, i := range written {
			back[j] = keys[i]
		}
		after, err := tx.Rows(ctx, target, cols, keyAt, back, false)
		if err != nil {
			return done, r.Classify(err, "read back the batch's rows of "+target.String())
		}
		now, failure := indexRows(r.Engine, cols, keyAt, after, back, target, p.Key)
		if failure != nil {
			return done, failure
		}
		// What the other columns of each inserted row hold right after the insert: an undo deletes the
		// row only while they still do.
		var wholes map[int]string
		if whole {
			var inserted [][]*string
			var at []int
			for _, i := range written {
				if did[i] == "inserted" {
					inserted = append(inserted, keys[i])
					at = append(at, i)
				}
			}
			got, failure := r.otherColumns(ctx, tx, p, inserted, false)
			if failure != nil {
				return done, failure
			}
			wholes = make(map[int]string, len(got))
			for j, i := range at {
				if h, ok := got[j]; ok {
					wholes[i] = h
				}
			}
		}
		for _, i := range written {
			row := now.find(widen(keys[i], keyAt, len(cols)))
			if row == nil {
				return done, job.Fail("database", "%s did not keep a row this write gave it: a trigger or a rule there may change or drop rows.", target)
			}
			o := WrittenRow{Key: rows[i].Key, Outcome: "written", Sent: strp(pull.RowHash(rows[i].Values)), Held: strp(pull.RowHash(row)), Set: sets[i], Before: befores[i]}
			if did[i] != "" {
				o.Did = strp(did[i])
			}
			if h, ok := wholes[i]; ok {
				o.Whole = strp(h)
			}
			if rehearse {
				o.After = row
			}
			outcomes[i] = o
		}
	}
	done.outcomes = outcomes
	for i, o := range outcomes {
		if rehearse && o.Outcome != "held" {
			done.touched = append(done.touched, touches[i])
		}
	}
	return done, nil
}

// restored reads back, after a rehearsal's rollback and outside any transaction, every row it wrote or
// removed, and counts those that hold exactly what they held before it: the same row, or still none.
// The rows it held it never wrote, so they are not counted: rows written less restored is how many
// differ.
func (r *runState) restored(ctx context.Context, parts []*writePart, touched [][]touch, limits Limits) (int64, *job.Error) {
	var n int64
	step := max(1, limits.BatchRows)
	for i, p := range parts {
		rows := touched[i]
		for start := 0; start < len(rows); start += step {
			chunk := rows[start:min(start+step, len(rows))]
			keys := make([][]*string, len(chunk))
			for j, t := range chunk {
				v, err := keyValues(t.key, len(p.keyAt))
				if err != nil {
					return 0, job.Fail("store", "The preview holds a key this runner cannot read (%s).", err)
				}
				keys[j] = v
			}
			back, err := r.Database.Rows(ctx, p.Target, p.cols, p.keyAt, keys)
			if err != nil {
				return 0, r.Classify(err, "read back the rehearsal's rows of "+p.Target.String())
			}
			found, failure := indexRows(r.Engine, p.cols, p.keyAt, back, keys, p.Target, p.Key)
			if failure != nil {
				return 0, failure
			}
			for j, t := range chunk {
				row := found.find(widen(keys[j], p.keyAt, len(p.cols)))
				if (row == nil && !t.had) || (row != nil && t.had && pull.RowHash(row) == t.before) {
					n++
				}
			}
		}
	}
	return n, nil
}

// columnAt is the place of the column named `name` among cols: its exact name, else the one column
// that has it without regard to case; -1 for none.
func columnAt(cols []engine.Column, name string) int {
	if at := slices.IndexFunc(cols, func(c engine.Column) bool { return c.Name == name }); at >= 0 {
		return at
	}
	at := -1
	for i, c := range cols {
		if strings.EqualFold(c.Name, name) {
			if at >= 0 {
				return -1
			}
			at = i
		}
	}
	return at
}
