package push_test

// A push, a preview, a compare and an undo on a database in memory: what each sends the store, and
// exactly what a write writes. The same scenario runs against real servers in internal/run.

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/push"
	"hx-fortress/data-runner/internal/push/pushtest"
)

var row = pushtest.Row

// memDB is a database in memory: one table, town.permits, and the others a test adds. It counts every
// row it writes. A transaction keeps its own copy of each table it touches until it commits.
type memDB struct {
	columns                    []engine.Column
	key                        []string
	required                   []string
	rows                       [][]*string
	inserted, updated, deleted int
	// failCommit fails the next commit.
	failCommit bool
	// edit runs once at the start of the next transaction: a person changing the table meanwhile.
	edit func(db *memDB)
	// fold makes the key's collation ignore case, as MySQL's and SQL Server's defaults do.
	fold bool
	// others are the database's other tables.
	others map[push.Table]*memDB
	// failInsert fails the next insert into this table, as a row that breaks one of its rules does.
	failInsert bool
	// keptBy names an engine without transactions that keeps this table, as MySQL's MyISAM does.
	keptBy string
	// asked are the values reads by value asked this table for, and linkReads how many reads asked.
	asked     []string
	linkReads int
	// ops are the root's log of what each transaction wrote, table by table, and rollbacks counts the
	// transactions rolled back.
	ops       []string
	rollbacks int
	// deferredChecks counts a rehearsal's checks of what the database checks at a commit, and
	// deferredFails is what each of them answers: a deferred constraint the rehearsal broke.
	deferredChecks int
	deferredFails  error
}

// table is one of the database's tables.
func (d *memDB) table(t push.Table) (*memDB, error) {
	if o, ok := d.others[t]; ok {
		return o, nil
	}
	if t == target {
		return d, nil
	}
	return nil, fmt.Errorf("no table %s", t)
}

// keyOf is a row's key as this database's collation reads it.
func (d *memDB) keyOf(columns []engine.Column, values []*string, key []int) string {
	if d.fold {
		return engine.FoldKey("mysql", columns, values, key)
	}
	return engine.CanonKey("mysql", columns, values, key)
}

func newDB(rows ...[]*string) *memDB {
	return &memDB{
		columns: []engine.Column{engine.NewColumn("permit_no", "VARCHAR"), engine.NewColumn("status", "VARCHAR"), engine.NewColumn("fee", "DECIMAL"), engine.NewColumn("edited_by", "VARCHAR")},
		key:     []string{"permit_no"},
		rows:    rows,
	}
}

func (d *memDB) Describe(_ context.Context, t push.Table) (push.Described, error) {
	tb, err := d.table(t)
	if err != nil {
		return push.Described{}, err
	}
	return push.Described{Columns: tb.columns, Key: tb.key, Required: tb.required}, nil
}

func (d *memDB) Count(_ context.Context, t push.Table) (int64, error) {
	tb, err := d.table(t)
	if err != nil {
		return 0, err
	}
	return int64(len(tb.rows)), nil
}

// project is a stored row's values at `columns` (a job's columns are some of the table's).
func (d *memDB) project(stored []*string, columns []engine.Column) []*string {
	out := make([]*string, len(columns))
	for i, c := range columns {
		out[i] = stored[slices.IndexFunc(d.columns, func(x engine.Column) bool { return x.Name == c.Name })]
	}
	return out
}

func (d *memDB) find(rows [][]*string, columns []engine.Column, key []int, k []*string) int {
	want := make([]*string, len(columns))
	for i, at := range key {
		want[at] = k[i]
	}
	for i, stored := range rows {
		if d.keyOf(columns, d.project(stored, columns), key) == d.keyOf(columns, want, key) {
			return i
		}
	}
	return -1
}

// read is every row whose key is one of keys, as a database answers a read by key: a key that names
// two rows answers both.
func (d *memDB) read(rows [][]*string, columns []engine.Column, key []int, keys [][]*string) [][]*string {
	wanted := map[string]bool{}
	for _, k := range keys {
		want := make([]*string, len(columns))
		for i, at := range key {
			want[at] = k[i]
		}
		wanted[d.keyOf(columns, want, key)] = true
	}
	out := [][]*string{}
	for _, stored := range rows {
		if values := d.project(stored, columns); wanted[d.keyOf(columns, values, key)] {
			out = append(out, values)
		}
	}
	return out
}

func (d *memDB) Rows(_ context.Context, t push.Table, columns []engine.Column, key []int, keys [][]*string) ([][]*string, error) {
	tb, err := d.table(t)
	if err != nil {
		return nil, err
	}
	return tb.read(tb.rows, columns, key, keys), nil
}

// Linked answers the column's distinct values among values, as its collation reads them.
func (d *memDB) Linked(_ context.Context, t push.Table, column engine.Column, values []*string) ([]*string, error) {
	tb, err := d.table(t)
	if err != nil {
		return nil, err
	}
	tb.linkReads++
	at := slices.IndexFunc(tb.columns, func(c engine.Column) bool { return c.Name == column.Name })
	one := []engine.Column{column}
	wanted := map[string]bool{}
	for _, v := range values {
		tb.asked = append(tb.asked, *v)
		wanted[tb.keyOf(one, []*string{v}, []int{0})] = true
	}
	seen := map[string]bool{}
	out := []*string{}
	for _, stored := range tb.rows {
		if v := stored[at]; v != nil && wanted[tb.keyOf(one, []*string{v}, []int{0})] && !seen[*v] {
			seen[*v] = true
			out = append(out, v)
		}
	}
	return out, nil
}

func (d *memDB) RollsBack(_ context.Context, t push.Table) (string, bool, error) {
	tb, err := d.table(t)
	if err != nil {
		return "", false, err
	}
	return tb.keptBy, tb.keptBy == "", nil
}

func (d *memDB) Write(context.Context) (push.Batch, error) {
	if d.edit != nil {
		d.edit(d)
		d.edit = nil
	}
	return &memBatch{db: d, work: map[*memDB]*memWork{}}, nil
}

// memBatch is a transaction: its own copy of each table it touched.
type memBatch struct {
	db   *memDB
	work map[*memDB]*memWork
	ops  []string
}

type memWork struct {
	rows                       [][]*string
	inserted, updated, deleted int
}

func (b *memBatch) of(t push.Table) (*memDB, *memWork, error) {
	tb, err := b.db.table(t)
	if err != nil {
		return nil, nil, err
	}
	w, ok := b.work[tb]
	if !ok {
		w = &memWork{rows: slices.Clone(tb.rows)}
		b.work[tb] = w
	}
	return tb, w, nil
}

func (b *memBatch) Rows(_ context.Context, t push.Table, columns []engine.Column, key []int, keys [][]*string, _ bool) ([][]*string, error) {
	tb, w, err := b.of(t)
	if err != nil {
		return nil, err
	}
	return tb.read(w.rows, columns, key, keys), nil
}

// full is a row of the job's columns as a row of the table: the columns it does not name are NULL.
func full(tb *memDB, columns []engine.Column, values []*string) []*string {
	out := make([]*string, len(tb.columns))
	for i, c := range columns {
		out[slices.IndexFunc(tb.columns, func(x engine.Column) bool { return x.Name == c.Name })] = values[i]
	}
	return out
}

func (b *memBatch) Insert(_ context.Context, t push.Table, columns []engine.Column, rows [][]*string) error {
	tb, w, err := b.of(t)
	if err != nil {
		return err
	}
	if tb.failInsert {
		tb.failInsert = false
		return errors.New("a row breaks a rule of the table")
	}
	for _, r := range rows {
		w.rows = append(w.rows, full(tb, columns, r))
		w.inserted++
	}
	b.ops = append(b.ops, "insert "+t.String())
	return nil
}

func (b *memBatch) Update(_ context.Context, t push.Table, columns []engine.Column, set, key []int, r []*string) error {
	tb, w, err := b.of(t)
	if err != nil {
		return err
	}
	k := make([]*string, len(key))
	for i, at := range key {
		k[i] = r[at]
	}
	at := tb.find(w.rows, columns, key, k)
	if at < 0 {
		return errors.New("no such row")
	}
	updated := slices.Clone(w.rows[at])
	for _, s := range set {
		updated[slices.IndexFunc(tb.columns, func(x engine.Column) bool { return x.Name == columns[s].Name })] = r[s]
	}
	w.rows[at] = updated
	w.updated++
	b.ops = append(b.ops, "update "+t.String())
	return nil
}

func (b *memBatch) Delete(_ context.Context, t push.Table, columns []engine.Column, key []int, keys [][]*string) error {
	tb, w, err := b.of(t)
	if err != nil {
		return err
	}
	for _, k := range keys {
		if at := tb.find(w.rows, columns, key, k); at >= 0 {
			w.rows = slices.Delete(w.rows, at, at+1)
			w.deleted++
		}
	}
	b.ops = append(b.ops, "delete "+t.String())
	return nil
}

func (b *memBatch) Commit() error {
	if b.db.failCommit {
		b.db.failCommit = false
		return errors.New("the connection closed")
	}
	for tb, w := range b.work {
		tb.rows = w.rows
		tb.inserted += w.inserted
		tb.updated += w.updated
		tb.deleted += w.deleted
	}
	b.db.ops = append(b.db.ops, b.ops...)
	return nil
}

func (b *memBatch) CheckDeferred(context.Context) error {
	b.db.deferredChecks++
	return b.db.deferredFails
}

func (b *memBatch) Rollback() error {
	b.db.rollbacks++
	return nil
}

var target = push.Table{Schema: "town", Name: "permits"}

func run(t *testing.T, kind string, store *pushtest.Store, db *memDB) (push.Counts, *job.Error) {
	t.Helper()
	return push.Run(context.Background(), push.Deps{
		Kind: kind, Store: store, Database: db, Engine: "mysql",
		Classify: func(err error, doing string) *job.Error { return job.Fail("database", "Could not %s: %s", doing, err) },
		Now:      time.Now,
		Sleep:    func(context.Context, time.Duration) error { return nil },
		Logf:     func(string, ...any) {},
	})
}

func mustRun(t *testing.T, kind string, store *pushtest.Store, db *memDB) push.Counts {
	t.Helper()
	counts, failure := run(t, kind, store, db)
	if failure != nil {
		t.Fatalf("%s: %+v", kind, failure)
	}
	return counts
}

var storeColumns = []string{"permit_no", "status", "fee", "_file"}

func TestAPreviewSaysWhatAWriteWouldDoAndTheWriteDoesExactlyThat(t *testing.T) {
	db := newDB(row("BP-1", "Issued", "175.00", "<null>"), row("BP-9", "Final", "1.00", "someone"))
	source := [][]*string{row("BP-1", "Issued", "175", "f1"), row("BP-2", "Final", "96.5", "f1"), row("BP-3", "Issued", "<null>", "f1")}

	preview := pushtest.New("push_preview", target, storeColumns, source)
	counts := mustRun(t, "compare", preview, db)
	if got := preview.Counts(); got["new"] != 2 || len(preview.Preview) != 2 {
		t.Fatalf("the preview: %v", got)
	}
	if counts.Same != 1 || counts.TargetRows != 2 || counts.Read != 3 || *preview.Ended.Same != 1 {
		t.Fatalf("its counts: %+v, the store heard %+v", counts, preview.Ended)
	}
	if strings.Join(preview.Columns, ",") != "permit_no,status,fee" || len(preview.Missing) != 0 {
		t.Fatalf("its columns: %v", preview.Columns)
	}
	if _, ok := preview.Memory["BP-1"]; !ok {
		t.Fatalf("a row the database already holds as the store does goes into the memory: %v", preview.Memory)
	}

	write := preview.ToPush()
	counts = mustRun(t, "push", write, db)
	if counts.Inserted != 2 || counts.Batches != 1 || db.inserted != 2 || db.updated+db.deleted != 0 {
		t.Fatalf("the write: %+v; the database wrote %d, %d, %d", counts, db.inserted, db.updated, db.deleted)
	}
	if len(write.Memory) != 3 || write.Outcomes["BP-2"].Outcome != "written" {
		t.Fatalf("the memory after the write: %v", write.Memory)
	}

	// Nothing changed: nothing is sent, and nothing written.
	again := write.Again("push_preview")
	if counts = mustRun(t, "compare", again, db); counts.Sent != 0 || counts.Same != 3 {
		t.Fatalf("a preview with nothing new: %+v", counts)
	}
}

func TestARowSomeoneChangedThereIsHeldUnlessTheWriteOverwrites(t *testing.T) {
	db := newDB()
	source := [][]*string{row("BP-1", "Issued", "10", "f"), row("BP-2", "Issued", "20", "f"), row("BP-3", "Issued", "30", "f")}
	first := pushtest.New("push_preview", target, storeColumns, source)
	first.Removes = true
	mustRun(t, "compare", first, db)
	mustRun(t, "push", first.ToPush(), db)

	// A person changes BP-1 and removes BP-2 there; the store changes BP-1 and BP-2 and drops BP-3.
	db.rows[0][1] = pushtest.Str("Void")
	db.rows = slices.Delete(db.rows, 1, 2)
	first.Source = [][]*string{row("BP-1", "Final", "10", "f"), row("BP-2", "Final", "20", "f")}
	second := first.Again("push_preview")
	mustRun(t, "compare", second, db)
	if got := second.Counts(); got["held"] != 2 || got["removed"] != 1 {
		t.Fatalf("the preview: %v", got)
	}
	if *second.Preview["BP-1"].Why != "changed_there" || *second.Preview["BP-2"].Why != "removed_there" {
		t.Fatalf("why each is held: %+v %+v", second.Preview["BP-1"], second.Preview["BP-2"])
	}

	overwrite := first.Again("push_preview")
	overwrite.TheirEdits = "overwrite"
	mustRun(t, "compare", overwrite, db)
	if got := overwrite.Counts(); got["changed"] != 1 || got["new"] != 1 || got["removed"] != 1 {
		t.Fatalf("a preview that overwrites: %v", got)
	}
	writes := db.inserted + db.updated + db.deleted
	mustRun(t, "push", overwrite.ToPush(), db)
	if db.inserted+db.updated+db.deleted-writes != 3 {
		t.Fatalf("the write that overwrites wrote %d rows", db.inserted+db.updated+db.deleted-writes)
	}
}

func TestARowChangedAfterThePreviewIsHeldAndALostBatchIsWrittenOnce(t *testing.T) {
	db := newDB(row("BP-1", "Issued", "10", "<null>"))
	source := [][]*string{row("BP-1", "Final", "10", "f"), row("BP-2", "Issued", "20", "f"), row("BP-3", "Issued", "30", "f")}
	preview := pushtest.New("push_preview", target, storeColumns, source)
	preview.Limits.BatchRows = 3
	mustRun(t, "compare", preview, db)
	if got := preview.Counts(); got["changed"] != 1 || got["new"] != 2 {
		t.Fatalf("the preview: %v", got)
	}
	// Between the preview and the write, BP-1 changes there and BP-2 appears there.
	db.edit = func(d *memDB) {
		d.rows[0][2] = pushtest.Str("11.00")
		d.rows = append(d.rows, row("BP-2", "Other", "1", "<null>"))
	}
	write := preview.ToPush()
	counts := mustRun(t, "push", write, db)
	if counts.Held != 2 || counts.Inserted != 1 || db.inserted != 1 || db.updated != 0 {
		t.Fatalf("the write: %+v; the database inserted %d, updated %d", counts, db.inserted, db.updated)
	}
	if *write.Outcomes["BP-1"].Why != "since_preview" || *write.Outcomes["BP-2"].Why != "appeared" {
		t.Fatalf("why: %+v %+v", write.Outcomes["BP-1"], write.Outcomes["BP-2"])
	}

	// The store does not hear of a batch the database took: the next data job finds its rows there.
	preview.Source = append(preview.Source, row("BP-4", "Issued", "40", "f"))
	fourth := preview.Again("push_preview")
	mustRun(t, "compare", fourth, db)
	lost := fourth.ToPush()
	lost.FailSend = 1
	if _, failure := run(t, "push", lost, db); failure == nil || failure.Code != "store" {
		t.Fatalf("a batch the store did not hear: %+v", failure)
	}
	inserted := db.inserted
	counts = mustRun(t, "push", lost, db)
	if counts.Inserted != 1 || db.inserted != inserted {
		t.Fatalf("the batch again: %+v; the database inserted %d more", counts, db.inserted-inserted)
	}
	if _, ok := lost.Memory["BP-4"]; !ok {
		t.Fatal("BP-4 is not in the memory")
	}

	// A batch whose commit fails tells the store nothing, and writes nothing.
	preview.Source = append(preview.Source, row("BP-5", "Issued", "50", "f"))
	fifth := lost.Again("push_preview")
	fifth.Source = preview.Source
	mustRun(t, "compare", fifth, db)
	failed := fifth.ToPush()
	db.failCommit = true
	if _, failure := run(t, "push", failed, db); failure == nil || failure.Code != "database" || failed.Page != 0 {
		t.Fatalf("a failed commit: %+v, page %d", failure, failed.Page)
	}
}

func TestACompareCountsWhatDiffersAndNothingElse(t *testing.T) {
	db := newDB()
	source := [][]*string{row("BP-1", "Issued", "10", "f"), row("BP-2", "Issued", "20", "f")}
	first := pushtest.New("push_preview", target, storeColumns, source)
	mustRun(t, "compare", first, db)
	mustRun(t, "push", first.ToPush(), db)
	db.rows = append(db.rows, row("BP-8", "Final", "1", "<null>"))
	db.rows[1][1] = pushtest.Str("Void")
	first.Source = [][]*string{row("BP-1", "Issued", "10.00", "f"), row("BP-3", "Issued", "30", "f")}
	compare := first.Again("compare")
	counts := mustRun(t, "compare", compare, db)
	if len(compare.Differences) != 2 || compare.Differences["BP-3"].Difference != "store_only" || compare.Differences["BP-2"].Difference != "database_only" {
		t.Fatalf("the compare: %+v", compare.Differences)
	}
	if counts.Same != 1 || counts.OtherRows != 1 || counts.TargetRows != 3 {
		t.Fatalf("its counts: %+v", counts)
	}
	if db.inserted != 2 || db.updated+db.deleted != 0 {
		t.Fatal("a compare wrote into the database")
	}
}

func TestWhatAPreviewRefuses(t *testing.T) {
	// A key that names two rows there.
	db := newDB(row("BP-1", "a", "1", "<null>"), row("bp-1 ", "b", "2", "<null>"))
	db.columns[0] = engine.NewColumn("permit_no", "CHAR")
	store := pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "a", "1", "f")})
	db.rows[1][0] = pushtest.Str("BP-1   ")
	if _, failure := run(t, "compare", store, db); failure == nil || !strings.Contains(failure.Message, "more than one row") {
		t.Fatalf("a key that is not unique there: %+v", failure)
	}
	// A new row the table needs a column for that the store's table lacks; an update needs none.
	db = newDB(row("BP-1", "a", "1", "<null>"))
	db.required = []string{"edited_by"}
	store = pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "b", "1", "f")})
	if _, failure := run(t, "compare", store, db); failure != nil {
		t.Fatalf("a preview with only changes: %+v", failure)
	}
	store = pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-2", "b", "1", "f")})
	if _, failure := run(t, "compare", store, db); failure == nil || !strings.Contains(failure.Message, "edited_by") {
		t.Fatalf("a new row with no edited_by: %+v", failure)
	}
	// A write data job is never handed a preview, nor a read one a write.
	if _, failure := run(t, "push", pushtest.New("push_preview", target, storeColumns, nil), db); failure == nil || failure.Code != "store" {
		t.Fatalf("a push data job on a preview: %+v", failure)
	}
	if _, failure := run(t, "compare", pushtest.New("push", target, storeColumns, nil), db); failure == nil || failure.Code != "store" {
		t.Fatalf("a compare data job on a push: %+v", failure)
	}
}

func TestPagesStayWithinTheStoresLimits(t *testing.T) {
	db := newDB()
	source := [][]*string{}
	for _, k := range []string{"A", "B", "C", "D", "E", "F", "G"} {
		source = append(source, row(k, "Issued", "1", "f"))
	}
	store := pushtest.New("push_preview", target, storeColumns, source)
	mustRun(t, "compare", store, db)
	// Seven rows at two a page: four pages.
	if store.Page != 4 || len(store.Preview) != 7 {
		t.Fatalf("pages %d, rows %d", store.Page, len(store.Preview))
	}
	write := store.ToPush()
	counts := mustRun(t, "push", write, db)
	// Seven rows at two a batch: four batches, each one page.
	if counts.Batches != 4 || write.Page != 4 || db.inserted != 7 {
		t.Fatalf("batches %d, pages %d, inserted %d", counts.Batches, write.Page, db.inserted)
	}
}

// A row the database already held with the store's values is noted, never put there by this store:
// once the store's table drops it, a preview forgets it and the write leaves it. A row this store put
// there is removed.
func TestAWriteRemovesOnlyARowThisStorePutThere(t *testing.T) {
	db := newDB(row("BP-1", "Issued", "175.00", "<null>"), row("BP-9", "Final", "1.00", "someone"))
	first := pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "Issued", "175", "f"), row("BP-2", "Final", "96.5", "f")})
	first.Removes = true
	mustRun(t, "compare", first, db)
	if first.Memory["BP-1"].Put || first.Preview["BP-2"].Action != "new" {
		t.Fatalf("the first preview: memory %v, preview %v", first.Memory, first.Counts())
	}
	write := first.ToPush()
	mustRun(t, "push", write, db)
	if !write.Memory["BP-2"].Put || write.Memory["BP-1"].Put {
		t.Fatalf("the memory after the write: %v", write.Memory)
	}

	// The store's table drops both. A preview not asked to remove leaves BP-2, and its memory.
	keeps := write.Again("push_preview")
	keeps.Removes = false
	keeps.Source = [][]*string{}
	mustRun(t, "compare", keeps, db)
	if len(keeps.Preview) != 0 || !keeps.Memory["BP-2"].Put {
		t.Fatalf("a preview not asked to remove: %v, memory %v", keeps.Preview, keeps.Memory)
	}
	again := write.Again("push_preview")
	again.Removes = true
	again.Source = [][]*string{}
	mustRun(t, "compare", again, db)
	if again.Preview["BP-2"].Action != "removed" || len(again.Preview) != 1 {
		t.Fatalf("the preview after the store dropped both: %v", again.Preview)
	}
	if _, kept := again.Memory["BP-1"]; kept {
		t.Fatalf("BP-1, which this store did not put there, is still in the memory: %v", again.Memory)
	}
	before := db.deleted
	mustRun(t, "push", again.ToPush(), db)
	if db.deleted-before != 1 || db.find(db.rows, db.columns, []int{0}, row("BP-1")) < 0 {
		t.Fatalf("the write deleted %d rows; BP-1 must stay", db.deleted-before)
	}

	// A compare counts BP-1 among the table's other rows.
	cmp := again.Again("compare")
	cmp.Source = [][]*string{}
	counts := mustRun(t, "compare", cmp, db)
	if len(cmp.Differences) != 0 || counts.OtherRows != 2 {
		t.Fatalf("the compare: %v, %+v", cmp.Differences, counts)
	}
}

// On a database that minds case, 'abc' is a row of its own: it never takes the row of 'ABC'. Where a
// collation ignores case, 'abc' finds 'ABC'.
func TestAKeyFindsAnotherCaseOfItselfOnlyWhereTheCollationIgnoresCase(t *testing.T) {
	minds := newDB(row("ABC", "Issued", "10.00", "<null>"))
	preview := pushtest.New("push_preview", target, storeColumns, [][]*string{row("ABC", "Issued", "10", "f"), row("abc", "Issued", "10", "f")})
	mustRun(t, "compare", preview, minds)
	if preview.Preview["abc"].Action != "new" {
		t.Fatalf("on a database that minds case, abc is new: %v", preview.Preview)
	}
	mustRun(t, "push", preview.ToPush(), minds)
	if minds.inserted != 1 || len(minds.rows) != 2 {
		t.Fatalf("abc was not inserted: %d rows", len(minds.rows))
	}

	ignores := newDB(row("ABC", "Issued", "10.00", "<null>"))
	ignores.fold = true
	only := pushtest.New("push_preview", target, storeColumns, [][]*string{row("abc", "Final", "10", "f")})
	mustRun(t, "compare", only, ignores)
	if only.Preview["abc"].Action != "changed" {
		t.Fatalf("where the collation ignores case, abc is the row ABC: %v", only.Preview)
	}
}

// Two of the store's keys that name one row as the database reads them fail the job, naming neither.
func TestTwoStoreKeysOfOneRowFailTheJob(t *testing.T) {
	db := &memDB{columns: []engine.Column{engine.NewColumn("id", "INT"), engine.NewColumn("status", "VARCHAR")}, key: []string{"id"}, rows: [][]*string{row("7", "Issued")}}
	preview := pushtest.New("push_preview", target, []string{"id", "status"}, [][]*string{row("7", "A"), row("007", "B")})
	_, failure := run(t, "compare", preview, db)
	if failure == nil || failure.Code != "store" || strings.Contains(failure.Message, "007") || !strings.Contains(failure.Message, "Two of the store's keys") {
		t.Fatalf("two keys of one row: %+v", failure)
	}
	fresh := pushtest.New("compare", target, []string{"id", "status"}, [][]*string{row("8", "A"), row("08", "B")})
	if _, failure := run(t, "compare", fresh, &memDB{columns: db.columns, key: db.key}); failure == nil || failure.Code != "store" {
		t.Fatalf("two new keys of one row: %+v", failure)
	}
}

// A key whose text changed ("42" to "42.0") still names its row: the preview forgets the old text,
// and the write removes nothing.
func TestAKeyWrittenAnotherWayStillHoldsItsRow(t *testing.T) {
	db := &memDB{columns: []engine.Column{engine.NewColumn("id", "INT"), engine.NewColumn("status", "VARCHAR")}, key: []string{"id"}}
	first := pushtest.New("push_preview", target, []string{"id", "status"}, [][]*string{row("42", "Issued")})
	mustRun(t, "compare", first, db)
	write := first.ToPush()
	mustRun(t, "push", write, db)

	again := write.Again("push_preview")
	again.Source = [][]*string{row("42.0", "Issued")}
	mustRun(t, "compare", again, db)
	if len(again.Preview) != 0 {
		t.Fatalf("a key written another way: %v", again.Preview)
	}
	if _, old := again.Memory["42"]; old {
		t.Fatalf("the old text is still in the memory: %v", again.Memory)
	}
	if _, now := again.Memory["42.0"]; !now {
		t.Fatalf("the new text is not in the memory: %v", again.Memory)
	}
}

// A binary value a pull named instead of keeping it stops only a write that would bind it.
func TestALongBinaryStopsOnlyAWriteThatBindsIt(t *testing.T) {
	name := "[binary, 2048 bytes, sha256 0011223344556677]"
	db := &memDB{columns: []engine.Column{engine.NewColumn("permit_no", "VARCHAR"), engine.NewColumn("status", "VARCHAR"), engine.NewColumn("scan", "BLOB")}, key: []string{"permit_no"}, rows: [][]*string{row("BP-1", "Issued", name)}}
	columns := []string{"permit_no", "status", "scan"}
	preview := pushtest.New("push_preview", target, columns, [][]*string{row("BP-1", "Final", name)})
	mustRun(t, "compare", preview, db)
	if preview.Preview["BP-1"].Action != "changed" || strings.Join(preview.Preview["BP-1"].Changed, ",") != "status" {
		t.Fatalf("a change of status beside a long binary: %v", preview.Preview)
	}
	mustRun(t, "push", preview.ToPush(), db)
	if db.updated != 1 || *db.rows[0][1] != "Final" {
		t.Fatalf("the write: %d updated, %v", db.updated, db.rows[0])
	}
	added := pushtest.New("push_preview", target, columns, [][]*string{row("BP-2", "Final", name)})
	if _, failure := run(t, "compare", added, db); failure == nil || !strings.Contains(failure.Message, "scan") {
		t.Fatalf("a new row would bind the long binary: %+v", failure)
	}
}

// ─── links, rehearsals, writes of several tables, undo ────────────────────────────────────────────

var (
	properties  = push.Table{Schema: "town", Name: "properties"}
	wards       = push.Table{Schema: "town", Name: "wards"}
	submissions = push.Table{Schema: "town", Name: "submissions"}
)

// deep is a copy of rows that shares no value with them.
func deep(rows [][]*string) [][]*string {
	out := make([][]*string, len(rows))
	for i, r := range rows {
		out[i] = make([]*string, len(r))
		for j, v := range r {
			if v != nil {
				out[i][j] = pushtest.Str(*v)
			}
		}
	}
	return out
}

// rowOf is the row of a key of town.permits, or nil.
func (d *memDB) rowOf(key string) []*string {
	if at := d.find(d.rows, d.columns, []int{0}, row(key)); at >= 0 {
		return d.rows[at]
	}
	return nil
}

// linkedDB is town.permits, whose parcel_id names a row of town.properties and whose ward names one of
// town.wards, with no foreign key to say so.
func linkedDB() *memDB {
	return &memDB{
		columns: []engine.Column{engine.NewColumn("permit_no", "VARCHAR"), engine.NewColumn("status", "VARCHAR"), engine.NewColumn("parcel_id", "VARCHAR"), engine.NewColumn("ward", "VARCHAR")},
		key:     []string{"permit_no"},
		rows:    [][]*string{row("BP-4", "Issued", "P-2", "1"), row("BP-5", "Final", "P-404", "1")},
		others: map[push.Table]*memDB{
			properties: {columns: []engine.Column{engine.NewColumn("parcel_id", "VARCHAR"), engine.NewColumn("owner", "VARCHAR")}, key: []string{"parcel_id"}, rows: [][]*string{row("P-1", "a"), row("P-2", "b"), row("P-7", "c")}},
			wards:      {columns: []engine.Column{engine.NewColumn("ward_no", "INT"), engine.NewColumn("name", "VARCHAR")}, key: []string{"ward_no"}, rows: [][]*string{row("1", "North"), row("7", "South")}},
		},
	}
}

// A preview counts, over the rows a write would write, how many find the row their link names, how
// many find none, and how many name none. It reads the linked table by the page's values only.
func TestAPreviewCountsTheLinksAWriteCannotMake(t *testing.T) {
	columns := []string{"permit_no", "status", "parcel_id", "ward"}
	source := [][]*string{
		// A page of new rows: BP-1 finds both (ward 07 is ward 7), BP-2 neither (no ward is x), BP-3 names none.
		row("BP-1", "Issued", "P-1", "07"), row("BP-2", "Issued", "P-9", "x"), row("BP-3", "Issued", "<null>", ""),
		// BP-4 changes; p-7 finds P-7 only where the collation ignores case.
		row("BP-4", "Final", "P-2", "1"), row("BP-6", "Issued", "p-7", "7"), row("BP-7", "Issued", "P-7", "7"),
		// The database holds BP-5 as the store does: not written, so not counted.
		row("BP-5", "Final", "P-404", "1"),
	}
	for _, fold := range []bool{false, true} {
		db := linkedDB()
		db.others[properties].fold = fold
		preview := pushtest.New("push_preview", target, columns, source)
		preview.Links = []push.LinkSpec{
			{Column: "parcel_id", To: push.LinkTo{Schema: "town", Name: "properties", Column: "parcel_id"}},
			{Column: "WARD", To: push.LinkTo{Schema: "town", Name: "wards", Column: "ward_no"}},
		}
		counts := mustRun(t, "compare", preview, db)
		if got := preview.Counts(); got["new"] != 5 || got["changed"] != 1 || len(preview.Preview) != 6 {
			t.Fatalf("fold %t: the preview: %v", fold, got)
		}
		parcels := push.LinkCount{Column: "parcel_id", To: "town.properties.parcel_id", Linked: 3, Unlinked: 2, Empty: 1}
		unlinked := map[string]string{"BP-2": "parcel_id,ward", "BP-6": "parcel_id"}
		if fold {
			parcels.Linked, parcels.Unlinked = 4, 1
			unlinked["BP-6"] = ""
		}
		want := []push.LinkCount{parcels, {Column: "ward", To: "town.wards.ward_no", Linked: 4, Unlinked: 1, Empty: 1}}
		if !reflect.DeepEqual(preview.Ended.Links, want) || !reflect.DeepEqual(counts.Links, want) {
			t.Fatalf("fold %t: the links: %+v, want %+v", fold, preview.Ended.Links, want)
		}
		for key, r := range preview.Preview {
			if got := strings.Join(r.Unlinked, ","); got != unlinked[key] {
				t.Errorf("fold %t: %s is unlinked by %q, want %q", fold, key, got, unlinked[key])
			}
		}
		// The linked tables are read by the values of the rows to write, a page at a time: never BP-5's
		// parcel, nor a ward that is not a number. On the page where p-7 and P-7 meet, they are asked apart.
		p, w := db.others[properties], db.others[wards]
		if slices.Contains(p.asked, "P-404") || slices.Contains(w.asked, "x") || p.linkReads != 3 || w.linkReads != 2 {
			t.Fatalf("fold %t: properties asked %v in %d reads, wards %v in %d", fold, p.asked, p.linkReads, w.asked, w.linkReads)
		}
	}

	// A link the job cannot count fails it by name, before a row is sent: its column is not one the
	// write writes, the linked table has no such column, or there is no such table.
	for _, c := range []struct {
		spec  push.LinkSpec
		names string
	}{
		{push.LinkSpec{Column: "owner", To: push.LinkTo{Schema: "town", Name: "properties", Column: "parcel_id"}}, "owner"},
		{push.LinkSpec{Column: "parcel_id", To: push.LinkTo{Schema: "town", Name: "properties", Column: "parcel"}}, "parcel"},
		{push.LinkSpec{Column: "parcel_id", To: push.LinkTo{Schema: "town", Name: "parcels", Column: "parcel_id"}}, "town.parcels"},
	} {
		preview := pushtest.New("push_preview", target, columns, source)
		preview.Links = []push.LinkSpec{c.spec}
		_, failure := run(t, "compare", preview, linkedDB())
		if failure == nil || failure.Code != "database" || !strings.Contains(failure.Message, c.names) || preview.Page != 0 {
			t.Fatalf("a link of %s to %s: %+v", c.spec.Column, c.spec.To, failure)
		}
	}
}

// A constraint the database checks only at a commit (Postgres's and Oracle's deferred ones) is checked
// before a rehearsal rolls back: a rehearsal the commit would refuse fails as the write would.
func TestARehearsalChecksWhatACommitWouldBeforeItRollsBack(t *testing.T) {
	db := newDB()
	preview := pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "Issued", "10", "f")})
	mustRun(t, "compare", preview, db)
	rehearsal := preview.ToPush()
	rehearsal.Rehearse = true
	db.deferredFails = errors.New("insert or update on table permits violates foreign key constraint permits_ward_fk")
	if _, failure := run(t, "push", rehearsal, db); failure == nil || failure.Code != "database" || !strings.Contains(failure.Message, "before the rehearsal's rollback") {
		t.Fatalf("a rehearsal a commit would refuse: %+v", failure)
	}
	if len(db.rows) != 0 || rehearsal.Ended != nil || db.rollbacks != 1 {
		t.Fatalf("the refused rehearsal left %v, ended %+v, %d rollbacks", db.rows, rehearsal.Ended, db.rollbacks)
	}
}

// A rehearsal writes exactly what a write would, in one transaction, rolls it back, and reads every row
// it wrote again: nothing stays in the database or the store's memory, and the store keeps a manifest.
func TestARehearsalWritesInOneTransactionAndLeavesNothing(t *testing.T) {
	db := newDB(row("BP-9", "Final", "1.00", "someone"))
	first := pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "Issued", "10", "f"), row("BP-2", "Issued", "20", "f"), row("BP-4", "Issued", "40", "f")})
	first.Removes = true
	mustRun(t, "compare", first, db)
	mustRun(t, "push", first.ToPush(), db)
	// The store changes BP-1 and BP-4, adds BP-3 and drops BP-2.
	first.Source = [][]*string{row("BP-1", "Final", "10", "f"), row("BP-3", "Issued", "30", "f"), row("BP-4", "Final", "40", "f")}
	preview := first.Again("push_preview")
	mustRun(t, "compare", preview, db)
	if got := preview.Counts(); got["changed"] != 2 || got["new"] != 1 || got["removed"] != 1 {
		t.Fatalf("the preview: %v", got)
	}
	// The town changes BP-4 after the preview: the rehearsal holds it, as the write would.
	db.rowOf("BP-4")[2] = pushtest.Str("41.00")
	rows, memory := deep(db.rows), maps.Clone(preview.Memory)
	written := db.inserted + db.updated + db.deleted

	rehearsal := preview.ToPush()
	rehearsal.Rehearse = true
	// Its data job stops after the first page: the database rolled it back, and the next one begins again.
	rehearsal.FailSend = 2
	if _, failure := run(t, "push", rehearsal, db); failure == nil || failure.Code != "store" {
		t.Fatalf("a rehearsal whose page the store did not take: %+v", failure)
	}
	counts := mustRun(t, "push", rehearsal, db)
	if !reflect.DeepEqual(db.rows, rows) || db.inserted+db.updated+db.deleted != written || db.rollbacks != 2 {
		t.Fatalf("the rehearsal left the database %v, %d rows written, %d rollbacks", db.rows, db.inserted+db.updated+db.deleted-written, db.rollbacks)
	}
	if !reflect.DeepEqual(rehearsal.Memory, memory) || len(rehearsal.Outcomes) != 0 || len(rehearsal.Wrote) != 0 {
		t.Fatalf("the rehearsal changed the store's memory: %v", rehearsal.Memory)
	}
	// Its three rows read back as they were; BP-4, which it held, it never wrote. One preview goes in its
	// write's order, every kind a batch at a time in key order, so its batches are the write's.
	if counts.Inserted != 1 || counts.Updated != 1 || counts.Deleted != 1 || counts.Held != 1 || counts.Batches != 2 || !counts.RolledBack || counts.Restored != 3 {
		t.Fatalf("the rehearsal: %+v", counts)
	}
	if e := rehearsal.Ended; !e.RolledBack || e.Committed || *e.Restored != 3 || *e.Batches != 2 || rehearsal.BegunAgain != 2 || db.deferredChecks != 1 {
		t.Fatalf("the store heard %+v after %d begins, %d checks of what a commit checks", e, rehearsal.BegunAgain, db.deferredChecks)
	}
	m := rehearsal.Manifest
	if bp1 := m["BP-1"]; len(m) != 4 || m["BP-4"].Outcome != "held" || *bp1.Did != "updated" || strings.Join(bp1.Set, ",") != "status" || *bp1.Before[1] != "Issued" || *bp1.After[1] != "Final" {
		t.Fatalf("the manifest: %+v", m)
	}
	if bp3 := m["BP-3"]; *bp3.Did != "inserted" || bp3.Before != nil || *bp3.After[0] != "BP-3" {
		t.Fatalf("BP-3 in the manifest: %+v", bp3)
	}
	if bp2 := m["BP-2"]; bp2.Outcome != "removed" || *bp2.Before[0] != "BP-2" || bp2.After != nil {
		t.Fatalf("BP-2 in the manifest: %+v", bp2)
	}

	// The preview was not used up: its write follows, writes the same three rows, and holds BP-4.
	mustRun(t, "push", preview.ToPush(), db)
	if got := db.inserted + db.updated + db.deleted - written; got != 3 || *db.rowOf("BP-1")[1] != "Final" || db.rowOf("BP-2") != nil {
		t.Fatalf("the write after the rehearsal wrote %d rows: %v", got, db.rows)
	}
}

// townDB is town.permits, and town.submissions, each a submission of a permit.
func townDB() *memDB {
	db := newDB()
	db.others = map[push.Table]*memDB{submissions: {
		columns: []engine.Column{engine.NewColumn("submission_id", "VARCHAR"), engine.NewColumn("permit_no", "VARCHAR"), engine.NewColumn("received", "DATE")},
		key:     []string{"submission_id"},
	}}
	return db
}

var submissionColumns = []string{"submission_id", "permit_no", "received"}

// A write of several tables is one transaction: one table's refused row leaves nothing of the other.
// Their new and changed rows go in the order given, their removed rows in the reverse one, and an
// undo goes back in the reverse order too.
func TestAWriteOfSeveralTablesIsWrittenWholeOrNotAtAll(t *testing.T) {
	db := townDB()
	subs := db.others[submissions]
	permits := pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "Issued", "10", "f"), row("BP-2", "Issued", "20", "f"), row("BP-3", "Issued", "30", "f")})
	received := pushtest.New("push_preview", submissions, submissionColumns, [][]*string{row("S-1", "BP-1", "2026-01-02"), row("S-2", "BP-2", "2026-01-03")})
	permits.Removes, received.Removes = true, true
	mustRun(t, "compare", permits, db)
	mustRun(t, "compare", received, db)

	subs.failInsert = true
	write := permits.ToPushWith(received)
	if _, failure := run(t, "push", write, db); failure == nil || failure.Code != "database" {
		t.Fatalf("a write whose second table refused a row: %+v", failure)
	}
	if len(db.rows)+len(subs.rows) != 0 || db.inserted+subs.inserted != 0 || len(permits.Memory)+len(received.Memory) != 0 || write.Page != 2 {
		t.Fatalf("after the refused row: permits %v, submissions %v, memory %v %v, page %d", db.rows, subs.rows, permits.Memory, received.Memory, write.Page)
	}
	// The next data job begins again, and the store forgets the pages it took.
	counts := mustRun(t, "push", write, db)
	if counts.Inserted != 5 || counts.Batches != 3 || len(db.rows) != 3 || len(subs.rows) != 2 || len(permits.Memory) != 3 || len(received.Memory) != 2 {
		t.Fatalf("the write: %+v; %d permits, %d submissions", counts, len(db.rows), len(subs.rows))
	}
	if !write.Ended.Committed || write.BegunAgain != 2 || write.Wrote["BP-1"].Did != "inserted" || write.Also[0].Wrote["S-2"].Did != "inserted" {
		t.Fatalf("the store heard %+v; it wrote %v and %v", write.Ended, write.Wrote, write.Also[0].Wrote)
	}

	// BP-1 changes, BP-2 and its submission go, BP-3 gets one.
	permits.Source = [][]*string{row("BP-1", "Final", "10", "f"), row("BP-3", "Issued", "30", "f")}
	received.Source = [][]*string{row("S-1", "BP-1", "2026-01-02"), row("S-3", "BP-3", "2026-01-04")}
	again, more := permits.Again("push_preview"), received.Again("push_preview")
	mustRun(t, "compare", again, db)
	mustRun(t, "compare", more, db)
	db.ops = nil
	second := again.ToPushWith(more)
	mustRun(t, "push", second, db)
	if want := []string{"update town.permits", "insert town.submissions", "delete town.submissions", "delete town.permits"}; !reflect.DeepEqual(db.ops, want) {
		t.Fatalf("the second write did %v, want %v", db.ops, want)
	}

	// Its undo turns the write's order around: the rows it removed go back parent first (permits, then
	// submissions), then the rows it inserted and changed go child first (submissions, then permits).
	db.ops = nil
	undo := second.Undo()
	counts = mustRun(t, "push", undo, db)
	if want := []string{"insert town.permits", "insert town.submissions", "delete town.submissions", "update town.permits"}; !reflect.DeepEqual(db.ops, want) {
		t.Fatalf("the undo did %v, want %v", db.ops, want)
	}
	if counts.Deleted != 1 || counts.Inserted != 2 || counts.Updated != 1 || counts.Held != 0 || len(db.rows) != 3 || len(subs.rows) != 2 || *db.rowOf("BP-1")[1] != "Issued" {
		t.Fatalf("the undo: %+v; permits %v, submissions %v", counts, db.rows, subs.rows)
	}
}

// A one-transaction write the database committed and the store never heard of is written once: the
// next data job finds its rows already holding what it sent.
func TestACommittedWriteTheStoreDidNotHearIsWrittenOnce(t *testing.T) {
	db := townDB()
	subs := db.others[submissions]
	permits := pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "Issued", "10", "f"), row("BP-2", "Issued", "20", "f")})
	received := pushtest.New("push_preview", submissions, submissionColumns, [][]*string{row("S-1", "BP-1", "2026-01-02")})
	mustRun(t, "compare", permits, db)
	mustRun(t, "compare", received, db)
	write := permits.ToPushWith(received)
	write.FailEnd = 1
	if _, failure := run(t, "push", write, db); failure == nil || failure.Code != "store" {
		t.Fatalf("an end the store did not hear: %+v", failure)
	}
	if len(db.rows) != 2 || len(subs.rows) != 1 || len(permits.Memory) != 0 {
		t.Fatalf("the database committed %d and %d rows; the store's memory holds %v", len(db.rows), len(subs.rows), permits.Memory)
	}
	inserted := db.inserted + subs.inserted
	counts := mustRun(t, "push", write, db)
	if db.inserted+subs.inserted != inserted || counts.Inserted != 3 || len(permits.Memory) != 2 || len(received.Memory) != 1 {
		t.Fatalf("the write again: %+v; the database inserted %d more", counts, db.inserted+subs.inserted-inserted)
	}
	// The preview found them new, so the first data job inserted them: an undo removes them.
	if w := write.Wrote["BP-1"]; w.Did != "inserted" || write.Outcomes["BP-1"].Outcome != "written" {
		t.Fatalf("BP-1 after the write again: %+v", w)
	}
	undo := write.Undo()
	if counts := mustRun(t, "push", undo, db); counts.Deleted != 3 || counts.Held != 0 || len(db.rows) != 0 || len(subs.rows) != 0 {
		t.Fatalf("the undo of the write again: %+v; permits %v, submissions %v", counts, db.rows, subs.rows)
	}
}

// An undo the database committed and the store never heard of is begun again, and its next data job
// finds every row already as the undo leaves it: each counts as undone, none held, and the memory goes
// back to what it was before the write.
func TestAnUndoBegunAgainAfterItsCommitFindsItsRowsUndone(t *testing.T) {
	db := newDB()
	first := pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "Issued", "10", "f")})
	mustRun(t, "compare", first, db)
	mustRun(t, "push", first.ToPush(), db)
	before := maps.Clone(first.Memory)
	first.Source = [][]*string{row("BP-1", "Final", "10", "f"), row("BP-2", "Issued", "20", "f")}
	preview := first.Again("push_preview")
	mustRun(t, "compare", preview, db)
	write := preview.ToPush()
	mustRun(t, "push", write, db)

	undo := write.Undo()
	undo.FailEnd = 1
	if _, failure := run(t, "push", undo, db); failure == nil || failure.Code != "store" {
		t.Fatalf("an undo's end the store did not hear: %+v", failure)
	}
	if db.rowOf("BP-2") != nil || *db.rowOf("BP-1")[1] != "Issued" {
		t.Fatalf("the database committed the undo: %v", db.rows)
	}
	writes := db.inserted + db.updated + db.deleted
	counts := mustRun(t, "push", undo, db)
	if counts.Held != 0 || counts.Deleted != 0 || counts.Updated != 0 || db.inserted+db.updated+db.deleted != writes {
		t.Fatalf("the undo again: %+v; the database wrote %d more rows", counts, db.inserted+db.updated+db.deleted-writes)
	}
	if want := map[string]string{"BP-1": "undone", "BP-2": "undone"}; !reflect.DeepEqual(undo.Undone[0], want) {
		t.Fatalf("the undo's rows: %v", undo.Undone[0])
	}
	if _, kept := write.Memory["BP-2"]; kept || write.Memory["BP-1"] != before["BP-1"] {
		t.Fatalf("the memory after the undo: %v, before the write %v", write.Memory, before)
	}
}

// The table's other columns are never the write's: an undo deletes a row the write inserted only while
// they hold what they held right after the insert, and inserts a row the write removed again only when
// they held nothing when it went. Otherwise the row is held: a value someone wrote there is theirs.
func TestAnUndoLeavesTheTablesOtherColumnsAlone(t *testing.T) {
	db := newDB()
	first := pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "Issued", "10", "f"), row("BP-2", "Issued", "20", "f")})
	first.Removes = true
	mustRun(t, "compare", first, db)
	mustRun(t, "push", first.ToPush(), db)
	// The town fills edited_by on BP-2, a column the store does not write; the store drops BP-2 and
	// adds BP-3.
	db.rowOf("BP-2")[3] = pushtest.Str("clerk")
	first.Source = [][]*string{row("BP-1", "Issued", "10", "f"), row("BP-3", "Issued", "30", "f")}
	preview := first.Again("push_preview")
	mustRun(t, "compare", preview, db)
	write := preview.ToPush()
	mustRun(t, "push", write, db)
	if write.Outcomes["BP-2"].Outcome != "removed" || write.Outcomes["BP-2"].Whole == nil || write.Outcomes["BP-3"].Whole == nil {
		t.Fatalf("the write's outcomes: %+v", write.Outcomes)
	}
	// The town then fills edited_by on BP-3, which the write inserted.
	db.rowOf("BP-3")[3] = pushtest.Str("inspector")

	undo := write.Undo()
	counts := mustRun(t, "push", undo, db)
	if counts.Held != 2 || counts.Deleted != 0 || counts.Inserted != 0 {
		t.Fatalf("the undo: %+v, rows %v", counts, undo.Undone[0])
	}
	if want := map[string]string{"BP-2": "columns", "BP-3": "changed"}; !reflect.DeepEqual(undo.UndoneWhy[0], want) {
		t.Fatalf("why the undo held each row: %v", undo.UndoneWhy[0])
	}
	if r := db.rowOf("BP-3"); r == nil || *r[3] != "inspector" || db.rowOf("BP-2") != nil {
		t.Fatalf("after the undo: %v", db.rows)
	}
}

// The design's example: a write inserts BP-2026-0101, changes BP-2026-0102 from Issued to Closed, holds
// BP-2026-0103 (the town edited it since our last write), changes BP-2026-0104 and removes
// BP-2026-0105. The town changes BP-2026-0104 after the write. Its undo removes BP-2026-0101, puts
// BP-2026-0102 back to Issued, inserts BP-2026-0105 again, holds BP-2026-0104, and never touches
// BP-2026-0103.
func TestAnUndoPutsBackWhatAWriteDidWhileTheRowsHoldWhatItLeft(t *testing.T) {
	db := newDB()
	first := pushtest.New("push_preview", target, storeColumns, [][]*string{
		row("BP-2026-0102", "Issued", "175", "f"), row("BP-2026-0103", "Issued", "60", "f"),
		row("BP-2026-0104", "Issued", "80", "f"), row("BP-2026-0105", "Issued", "95", "f"),
	})
	first.Removes = true
	mustRun(t, "compare", first, db)
	mustRun(t, "push", first.ToPush(), db)
	before := maps.Clone(first.Memory)
	db.rowOf("BP-2026-0103")[1] = pushtest.Str("Void")
	first.Source = [][]*string{
		row("BP-2026-0101", "Issued", "12", "f"), row("BP-2026-0102", "Closed", "175", "f"),
		row("BP-2026-0103", "Final", "60", "f"), row("BP-2026-0104", "Final", "80", "f"),
	}
	preview := first.Again("push_preview")
	mustRun(t, "compare", preview, db)
	if got := preview.Counts(); got["new"] != 1 || got["changed"] != 2 || got["removed"] != 1 || got["held"] != 1 {
		t.Fatalf("the preview: %v", got)
	}
	write := preview.ToPush()
	mustRun(t, "push", write, db)
	// A write of one preview tells the store, batch by batch, what it did to each row.
	o := write.Outcomes
	if *o["BP-2026-0101"].Did != "inserted" || o["BP-2026-0101"].Before != nil || *o["BP-2026-0102"].Did != "updated" ||
		strings.Join(o["BP-2026-0102"].Set, ",") != "status" || *o["BP-2026-0102"].Before[1] != "Issued" ||
		o["BP-2026-0105"].Outcome != "removed" || *o["BP-2026-0105"].Before[2] != "95" || o["BP-2026-0102"].After != nil {
		t.Fatalf("the write's outcomes: %+v", o)
	}
	db.rowOf("BP-2026-0104")[2] = pushtest.Str("81.00")
	writes := db.inserted + db.updated + db.deleted

	undo := write.Undo()
	counts := mustRun(t, "push", undo, db)
	if counts.Deleted != 1 || counts.Updated != 1 || counts.Inserted != 1 || counts.Held != 1 || db.inserted+db.updated+db.deleted-writes != 3 {
		t.Fatalf("the undo: %+v; the database wrote %d rows", counts, db.inserted+db.updated+db.deleted-writes)
	}
	want := map[string]string{"BP-2026-0101": "undone", "BP-2026-0102": "undone", "BP-2026-0104": "held", "BP-2026-0105": "undone"}
	if !reflect.DeepEqual(undo.Undone[0], want) || !undo.Ended.Committed {
		t.Fatalf("the undo's rows: %v, its end %+v", undo.Undone[0], undo.Ended)
	}
	if db.rowOf("BP-2026-0101") != nil || *db.rowOf("BP-2026-0102")[1] != "Issued" || *db.rowOf("BP-2026-0103")[1] != "Void" {
		t.Fatalf("after the undo: %v", db.rows)
	}
	if r := db.rowOf("BP-2026-0104"); *r[1] != "Final" || *r[2] != "81.00" {
		t.Fatalf("BP-2026-0104, changed since the write, was touched: %v", r)
	}
	if r := db.rowOf("BP-2026-0105"); r == nil || *r[1] != "Issued" || *r[2] != "95" {
		t.Fatalf("BP-2026-0105 is not back: %v", r)
	}
	// Each undone key's memory is what it was before the write; the held one's is the write's.
	if _, kept := write.Memory["BP-2026-0101"]; kept || write.Memory["BP-2026-0102"] != before["BP-2026-0102"] || write.Memory["BP-2026-0105"] != before["BP-2026-0105"] || write.Memory["BP-2026-0104"] == before["BP-2026-0104"] {
		t.Fatalf("the memory after the undo: %v, before the write %v", write.Memory, before)
	}
	// A write is undone once.
	if _, failure := run(t, "push", write.Undo(), db); failure == nil || failure.Code != "store" {
		t.Fatalf("a second undo: %+v", failure)
	}
	// The next preview sees BP-2026-0102 as the store's own change again, and BP-2026-0104 as the town's.
	next := preview.Again("push_preview")
	mustRun(t, "compare", next, db)
	if next.Preview["BP-2026-0102"].Action != "changed" || next.Preview["BP-2026-0104"].Action != "held" || next.Preview["BP-2026-0101"].Action != "new" || next.Preview["BP-2026-0105"].Action != "removed" {
		t.Fatalf("the preview after the undo: %+v", next.Preview)
	}
}

// A removed row goes back with the write's columns only: where the table needs a value in a column the
// write did not write, the undo holds the row rather than fail the rest.
func TestAnUndoHoldsARowItCannotPutBackWhole(t *testing.T) {
	db := newDB()
	first := pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "Issued", "10", "f"), row("BP-2", "Issued", "20", "f")})
	first.Removes = true
	mustRun(t, "compare", first, db)
	mustRun(t, "push", first.ToPush(), db)
	// The town makes edited_by required; the store changes BP-1 and drops BP-2.
	db.required = []string{"edited_by"}
	first.Source = [][]*string{row("BP-1", "Final", "10", "f")}
	preview := first.Again("push_preview")
	mustRun(t, "compare", preview, db)
	write := preview.ToPush()
	mustRun(t, "push", write, db)
	undo := write.Undo()
	counts := mustRun(t, "push", undo, db)
	if counts.Updated != 1 || counts.Held != 1 || counts.Inserted != 0 || undo.Undone[0]["BP-2"] != "held" || undo.UndoneWhy[0]["BP-2"] != "columns" || db.rowOf("BP-2") != nil || *db.rowOf("BP-1")[1] != "Issued" {
		t.Fatalf("the undo: %+v, rows %v", counts, undo.Undone[0])
	}
}

// A table whose changes do not roll back (MySQL's MyISAM) takes no job in one transaction: a rehearsal
// there would leave its rows written. The job is refused by the table's name before the store hears of
// it or the database is written. A write of one preview, a batch at a time, still goes.
func TestAOneTransactionJobRefusesATableThatCannotRollBack(t *testing.T) {
	db := newDB()
	first := pushtest.New("push_preview", target, storeColumns, [][]*string{row("BP-1", "Issued", "10", "f")})
	mustRun(t, "compare", first, db)
	db.keptBy = "MyISAM"
	rehearsal := first.ToPush()
	rehearsal.Rehearse = true
	if _, failure := run(t, "push", rehearsal, db); failure == nil || failure.Code != "database" || !strings.Contains(failure.Message, "town.permits is a MyISAM table") {
		t.Fatalf("a rehearsal on a MyISAM table: %+v", failure)
	}
	if rehearsal.BegunAgain != 0 || rehearsal.Page != 0 || len(db.rows) != 0 || db.rollbacks != 0 {
		t.Fatalf("the refused rehearsal began %d times, sent %d pages, left %v", rehearsal.BegunAgain, rehearsal.Page, db.rows)
	}
	write := first.ToPush()
	mustRun(t, "push", write, db)
	if len(db.rows) != 1 {
		t.Fatalf("a write of one preview on a MyISAM table: %v", db.rows)
	}
	if _, failure := run(t, "push", write.Undo(), db); failure == nil || !strings.Contains(failure.Message, "MyISAM") || len(db.rows) != 1 {
		t.Fatalf("an undo on a MyISAM table: %+v", failure)
	}
}
