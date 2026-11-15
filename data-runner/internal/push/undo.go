package push

// An undo of one write, in one transaction: the write's own order turned around. First, table by
// table in the write's order, the rows it removed are inserted again, so a parent's row is back before
// its child's. Then, table by table in the reverse order, the rows it inserted are deleted and the
// rows it updated get the columns it set back to what they held before it, and only those, so a
// child's row goes before its parent's. Each a batch at a time, and each only while the database
// still holds exactly what the write left there: for an inserted or updated row the hash `held` of the
// write's columns, and for an inserted row the hash of the table's other columns too (`whole`: the
// write never writes them, so a value there since is someone else's, and deleting the row would take
// it); for a removed row, no row at all.
//
// A row that already holds what the undo would leave there counts as undone: an earlier data job of
// this undo committed it, and the store never heard. Any other row is held, and stays as it is, with
// why: it changed in the database since the write (changed); its other columns held values when the
// write removed it, or its table needs a value in a column the write did not write, so an undo cannot
// put it back whole (columns); or it holds a value too long to have been kept (too_long).
//
// The store hears each batch as pages and applies nothing until the end: the undo commits, then ends
// `committed`. A data job that stops before the end begins the undo again (`rows/begin` with
// `again`): the database rolled its part back, or it committed, and then each row is found undone.

import (
	"context"
	"encoding/json"
	"slices"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/pull"
)

// oneUndo is an undo as it goes: its transaction, its pages and batches, and what its batches did.
type oneUndo struct {
	tx      Batch
	page    int64
	batches int64
	counts  Counts
}

func (r *runState) undo(ctx context.Context, st State) *job.Error {
	parts, failure := r.describeParts(ctx, st.parts())
	if failure != nil {
		return failure
	}
	if failure := r.rollsBack(ctx, parts, "undo"); failure != nil {
		return failure
	}
	begun, err := r.Store.BeginAgain(ctx)
	if err != nil {
		return r.storeFailure(ctx, err, "begin the undo again")
	}
	r.Logf("undo: %d rows of %d tables, in one transaction", begun.Rows, len(parts))
	tx, err := r.Database.Write(ctx)
	if err != nil {
		return r.Classify(err, "begin the undo's transaction")
	}
	open := true
	defer func() {
		if open {
			_ = tx.Rollback()
		}
	}()
	u := &oneUndo{tx: tx}
	// The write removed a child's rows before its parent's: they go back parent first.
	for _, p := range parts {
		if failure := r.undoRows(ctx, u, p, "removals", st.Limits); failure != nil {
			return failure
		}
	}
	// It wrote a parent's rows before its child's: they go child first.
	for i := len(parts) - 1; i >= 0; i-- {
		if failure := r.undoRows(ctx, u, parts[i], "puts", st.Limits); failure != nil {
			return failure
		}
	}
	open = false
	if err := tx.Commit(); err != nil {
		return r.Classify(err, "commit the undo's transaction")
	}
	r.counts.add(u.counts)
	r.counts.Batches = u.batches
	if _, err := r.Store.End(ctx, EndBody{Batches: i64(u.batches), Committed: true}); err != nil {
		return r.storeFailure(ctx, err, "end the undo")
	}
	r.Logf("undo: %d batches, %d removed, %d put back, %d inserted again, %d held, committed", u.batches, u.counts.Deleted, u.counts.Updated, u.counts.Inserted, u.counts.Held)
	return nil
}

// undoRows undoes a part's rows of one kind, a batch at a time: the rows the write removed
// (removals), or the rows it inserted and updated (puts).
func (r *runState) undoRows(ctx context.Context, u *oneUndo, p *writePart, only string, limits Limits) *job.Error {
	var after *string
	for {
		answer, err := r.Store.Read(ctx, ReadBody{Part: "undo", After: after, Limit: limits.BatchRows, Table: p.index, Only: only})
		if err != nil {
			return r.storeFailure(ctx, err, "read the write's rows to undo")
		}
		if len(answer.Rows) == 0 {
			return nil
		}
		rows := make([]UndoRow, len(answer.Rows))
		for j, raw := range answer.Rows {
			if err := json.Unmarshal(raw, &rows[j]); err != nil {
				return job.Fail("store", "The store answered the write's rows in a shape this runner cannot read.")
			}
			// Every part's removed rows go back before any part's other rows: a row of the other kind
			// would break that order.
			if (only == "removals") != (rows[j].Did == "deleted") {
				asked := "it inserted or updated"
				if only == "removals" {
					asked = "it removed"
				}
				return job.Fail("store", "The store answered a row the write %s when asked for the rows %s only.", rows[j].Did, asked)
			}
		}
		outcomes, c, failure := r.undoBatch(ctx, u.tx, p, rows)
		if failure != nil {
			return failure
		}
		pages, failure := pagesOf(outcomes, undoneKey, limits, p.Target)
		if failure != nil {
			return failure
		}
		u.counts.add(c)
		u.batches++
		for _, pg := range pages {
			u.page++
			if failure := r.sendPending(ctx, u.page, pg, p.index, "send a batch of the undo"); failure != nil {
				return failure
			}
		}
		last := rows[len(rows)-1].Key
		after = &last
		if answer.Next == nil {
			return nil
		}
	}
}

// undoBatch undoes one batch of a write's rows inside tx, and answers how each ended.
func (r *runState) undoBatch(ctx context.Context, tx Batch, p *writePart, rows []UndoRow) ([]UndoneRow, Counts, *job.Error) {
	target, cols, keyAt := p.Target, p.cols, p.keyAt
	var counted Counts
	keys := make([][]*string, len(rows))
	for i, u := range rows {
		v, err := keyValues(u.Key, len(keyAt))
		if err != nil {
			return nil, counted, job.Fail("store", "The write's record holds a key this runner cannot read (%s).", err)
		}
		keys[i] = v
		switch u.Did {
		case "inserted", "updated":
			if u.Held == nil {
				return nil, counted, job.Fail("store", "The write's record holds a row it %s with no hash of what the database held after it.", u.Did)
			}
			if u.Did == "updated" && (len(u.Set) == 0 || len(u.Before) != len(cols)) {
				return nil, counted, job.Fail("store", "The write's record holds an update with no columns it set, or without the %d values to put back.", len(cols))
			}
		case "deleted":
			if len(u.Before) != len(cols) {
				return nil, counted, job.Fail("store", "The write's record holds a row it removed without the %d values to insert again.", len(cols))
			}
		default:
			return nil, counted, job.Fail("store", "The write's record holds a row it %q, which an undo does not undo.", u.Did)
		}
	}
	current, err := tx.Rows(ctx, target, cols, keyAt, keys, true)
	if err != nil {
		return nil, counted, r.Classify(err, "read and lock the rows of "+target.String()+" to undo")
	}
	found, failure := indexRows(r.Engine, cols, keyAt, current, keys, target, p.Key)
	if failure != nil {
		return nil, counted, failure
	}
	// The other columns of the rows the write inserted, which a delete would take with them: locked
	// already, by the read above.
	var wholes map[int]string
	if len(p.extra) > 0 {
		var inserted [][]*string
		var at []int
		for i, u := range rows {
			if u.Did == "inserted" {
				inserted = append(inserted, keys[i])
				at = append(at, i)
			}
		}
		got, failure := r.otherColumns(ctx, tx, p, inserted, false)
		if failure != nil {
			return nil, counted, failure
		}
		wholes = make(map[int]string, len(got))
		for j, i := range at {
			if h, ok := got[j]; ok {
				wholes[i] = h
			}
		}
	}
	outcomes := make([]UndoneRow, len(rows))
	var deletes, inserts, putBack [][]*string
	var updates []update
	// The rows undone, by their place in the batch: read back, they must be there, or gone.
	var undone []int
	for i, u := range rows {
		cur := found.find(widen(keys[i], keyAt, len(cols)))
		why := ""
		switch u.Did {
		case "inserted":
			switch {
			case cur == nil:
				// Gone already: what the undo would leave there.
			case pull.RowHash(cur) != *u.Held || !sameWhole(p.extra, u.Whole, wholes, i):
				why = "changed"
			default:
				deletes = append(deletes, keys[i])
				counted.Deleted++
			}
		case "updated":
			set := make([]int, 0, len(u.Set))
			for _, name := range u.Set {
				if at := slices.IndexFunc(cols, func(c engine.Column) bool { return c.Name == name }); at >= 0 && !slices.Contains(keyAt, at) && !slices.Contains(set, at) {
					set = append(set, at)
				}
			}
			if len(set) == 0 {
				return nil, counted, job.Fail("store", "The write's record holds an update that names none of the write's columns.")
			}
			switch {
			case cur == nil:
				why = "changed"
			case pull.RowHash(cur) == *u.Held:
				if r.tooLong(cols, u.Before, set) {
					why = "too_long"
					break
				}
				// Only the columns the write set go back, at the key that found the row.
				row := slices.Clone(u.Before)
				for j, at := range keyAt {
					row[at] = keys[i][j]
				}
				updates = append(updates, update{at: len(putBack), set: set})
				putBack = append(putBack, row)
				counted.Updated++
			case sameAt(cur, u.Before, set):
				// Holds what the undo puts back already.
			default:
				why = "changed"
			}
		case "deleted":
			switch {
			case cur != nil && pull.RowHash(cur) == pull.RowHash(u.Before):
				// Back already.
			case cur != nil:
				why = "changed"
			case len(p.missing) > 0 || !emptyWholeOf(p.extra, u.Whole):
				// The row goes back with the write's columns only: other columns that held values, or
				// a table that needs one in a column the write did not write, cannot have it back whole.
				why = "columns"
			case r.tooLong(cols, u.Before, nil):
				why = "too_long"
			default:
				inserts = append(inserts, u.Before)
				counted.Inserted++
			}
		}
		if why != "" {
			outcomes[i] = UndoneRow{Key: u.Key, Outcome: "held", Why: why}
			counted.Held++
			continue
		}
		outcomes[i] = UndoneRow{Key: u.Key, Outcome: "undone"}
		undone = append(undone, i)
	}
	if len(deletes) > 0 {
		if err := tx.Delete(ctx, target, cols, keyAt, deletes); err != nil {
			return nil, counted, r.Classify(err, "remove the rows this write inserted into "+target.String())
		}
	}
	for _, u := range updates {
		if err := tx.Update(ctx, target, cols, u.set, keyAt, putBack[u.at]); err != nil {
			return nil, counted, r.Classify(err, "put back a row of "+target.String())
		}
	}
	if len(inserts) > 0 {
		if err := tx.Insert(ctx, target, cols, inserts); err != nil {
			return nil, counted, r.Classify(err, "insert again the rows this write removed from "+target.String())
		}
	}
	if len(undone) > 0 {
		back := make([][]*string, len(undone))
		for j, i := range undone {
			back[j] = keys[i]
		}
		after, err := tx.Rows(ctx, target, cols, keyAt, back, false)
		if err != nil {
			return nil, counted, r.Classify(err, "read back the undone rows of "+target.String())
		}
		now, failure := indexRows(r.Engine, cols, keyAt, after, back, target, p.Key)
		if failure != nil {
			return nil, counted, failure
		}
		for _, i := range undone {
			there := now.find(widen(keys[i], keyAt, len(cols))) != nil
			if there == (rows[i].Did == "inserted") {
				return nil, counted, job.Fail("database", "%s did not keep what this undo did to a row: a trigger or a rule there may change or drop rows.", target)
			}
		}
	}
	return outcomes, counted, nil
}

// sameWhole says an inserted row's other columns hold what they held right after the write: the same
// hash over the same columns, or no other columns then and now.
func sameWhole(extra []engine.Column, recorded *string, now map[int]string, i int) bool {
	if len(extra) == 0 || recorded == nil {
		return len(extra) == 0 && recorded == nil
	}
	h, ok := now[i]
	return ok && h == *recorded
}

// emptyWholeOf says a removed row's other columns held nothing when the write removed it, over the
// same columns, or the table had none then and has none now.
func emptyWholeOf(extra []engine.Column, recorded *string) bool {
	if len(extra) == 0 || recorded == nil {
		return len(extra) == 0 && recorded == nil
	}
	return *recorded == emptyWhole(extra)
}

// sameAt says two rows hold the same values in the columns at `at`.
func sameAt(a, b []*string, at []int) bool {
	for _, i := range at {
		if (a[i] == nil) != (b[i] == nil) || (a[i] != nil && *a[i] != *b[i]) {
			return false
		}
	}
	return true
}

// tooLong says a row holds, in its columns at `at` (every column when nil), a binary value a pull named
// instead of keeping it: no write can put its bytes back.
func (r *runState) tooLong(cols []engine.Column, values []*string, at []int) bool {
	for i, c := range cols {
		if at != nil && !slices.Contains(at, i) {
			continue
		}
		if engine.TooLongToWrite(r.Engine, c, values[i]) {
			return true
		}
	}
	return false
}
