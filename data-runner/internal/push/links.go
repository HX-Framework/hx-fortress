package push

// A preview's links. A link is a column of the write whose value names a row of another table of the
// same database by one of its columns, with no foreign key to say so. For each page of the store's
// table, the distinct values of each link's column among the page's rows to write (new and changed)
// are read from the linked table by value (`SELECT DISTINCT c FROM t WHERE c IN (…)`), never the
// table whole, and each row counts as linked, unlinked or empty. A row whose link finds no row names
// its column in `unlinked`. Nothing is refused for a link the write cannot make: the counts are for a
// program's condition and a person.

import (
	"context"
	"slices"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
)

// link is one link as a preview checks it: its column among the job's, the linked table and its
// column, and the rows counted so far.
type link struct {
	// at is the link's column among the job's columns.
	at     int
	to     Table
	column engine.Column
	count  LinkCount
}

// linksOf finds each link's columns: the write's among the job's columns, and the linked table's,
// each table described once.
func (r *runState) linksOf(ctx context.Context, specs []LinkSpec, b *begun) ([]*link, *job.Error) {
	described := map[Table][]engine.Column{}
	out := make([]*link, 0, len(specs))
	for _, s := range specs {
		at := columnAt(b.cols, s.Column)
		if at < 0 {
			return nil, job.Fail("database", "A link names %s, which is not among the columns this write writes into %s.", s.Column, b.target)
		}
		to := Table{Schema: s.To.Schema, Name: s.To.Name}
		cols, ok := described[to]
		if !ok {
			d, err := r.Database.Describe(ctx, to)
			if err != nil {
				return nil, r.Classify(err, "read the columns of "+to.String())
			}
			cols = d.Columns
			described[to] = cols
		}
		c := columnAt(cols, s.To.Column)
		if c < 0 {
			return nil, job.Fail("database", "%s has no column %s that this login can read, so a link cannot name its rows by it.", to, s.To.Column)
		}
		// Counted under the write's column as the database spells it, as its rows name it in `unlinked`.
		out = append(out, &link{at: at, to: to, column: cols[c], count: LinkCount{Column: b.cols[at].Name, To: s.To.String()}})
	}
	return out, nil
}

// checkLinks counts a page's rows to write against each link, and names in each row the link columns
// whose value finds no row.
func (r *runState) checkLinks(ctx context.Context, links []*link, cols []engine.Column, rows []*PreviewRow) *job.Error {
	if len(links) == 0 {
		return nil
	}
	writes := make([]*PreviewRow, 0, len(rows))
	for _, row := range rows {
		if row.Action == "new" || row.Action == "changed" {
			writes = append(writes, row)
		}
	}
	if len(writes) == 0 {
		return nil
	}
	for _, l := range links {
		linked, failure := r.linked(ctx, l, writes)
		if failure != nil {
			return failure
		}
		name := cols[l.at].Name
		for _, row := range writes {
			v := row.After[l.at]
			switch {
			case v == nil || *v == "":
				l.count.Empty++
			case linked[r.canonOne(l.column, v)]:
				l.count.Linked++
			default:
				l.count.Unlinked++
				if !slices.Contains(row.Unlinked, name) {
					row.Unlinked = append(row.Unlinked, name)
				}
			}
		}
	}
	return nil
}

// linked reads which of the rows' values of a link's column the linked table holds, by the linked
// column's reading of each (engine.CanonKey of one column). A database whose collation ignores case
// answers its own 'ABC' for 'abc', so a value answered that is none of those asked is matched without
// regard to case; to keep that match certain, values that differ only by case are asked in separate
// rounds. A value that does not read as the linked column's kind (text in a number's column) is held by
// no row there, and is not asked.
func (r *runState) linked(ctx context.Context, l *link, rows []*PreviewRow) (map[string]bool, *job.Error) {
	type asked struct {
		value          *string
		canon, without string
	}
	seen := map[string]bool{}
	classes := map[string]int{}
	var rounds [][]asked
	for _, row := range rows {
		v := row.After[l.at]
		if v == nil || *v == "" || !engine.Readable(r.Engine, l.column, *v) {
			continue
		}
		c := r.canonOne(l.column, v)
		if seen[c] {
			continue
		}
		seen[c] = true
		f := engine.FoldKey(r.Engine, []engine.Column{l.column}, []*string{v}, []int{0})
		n := classes[f]
		classes[f] = n + 1
		if n == len(rounds) {
			rounds = append(rounds, nil)
		}
		rounds[n] = append(rounds[n], asked{value: v, canon: c, without: f})
	}
	out := map[string]bool{}
	for _, round := range rounds {
		values := make([]*string, len(round))
		for i, a := range round {
			values[i] = a.value
		}
		held, err := r.Database.Linked(ctx, l.to, l.column, values)
		if err != nil {
			return nil, r.Classify(err, "read which rows of "+l.to.String()+" the links name")
		}
		exact, folded := map[string]bool{}, map[string]bool{}
		for _, h := range held {
			if h == nil {
				continue
			}
			exact[r.canonOne(l.column, h)] = true
			folded[engine.FoldKey(r.Engine, []engine.Column{l.column}, []*string{h}, []int{0})] = true
		}
		for _, a := range round {
			// In a round no two values differ only by case, so a value found without regard to case is
			// this one's.
			if exact[a.canon] || folded[a.without] {
				out[a.canon] = true
			}
		}
	}
	return out, nil
}

// canonOne is a value as a column's kind reads it (CanonKey of one column).
func (r *runState) canonOne(c engine.Column, v *string) string {
	return engine.CanonKey(r.Engine, []engine.Column{c}, []*string{v}, []int{0})
}
