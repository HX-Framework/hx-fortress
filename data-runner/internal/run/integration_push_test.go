package run

// A push and a compare against real servers, each skipped unless its admin connection is given
// (integration_test.go lists them). One scenario runs on every engine, with the store in this test's
// memory (pushtest.Store): a preview, its write in batches, a preview with nothing to do, a row a
// person changed in the database held, a row changed between the preview and the write held, a
// batch the store never heard of written once, and a compare; then a preview that counts a link, its
// rehearsal (the database unchanged after), its write and that write's undo, and a write of two tables
// in one transaction, refused whole and then written whole. Triggers on the database's tables count
// every row inserted, updated and deleted, so the test knows exactly what each job wrote.

import (
	"context"
	"database/sql"
	"maps"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/push"
	"hx-fortress/data-runner/internal/push/pushtest"
)

// pushSite is one engine's side of the scenario: who reads and who writes, the table, and the
// owner's connection to change rows by hand and read the trigger's count.
type pushSite struct {
	engine string
	owner  *sql.DB
	// target is the table the store writes; strict is one with a column a new row must fill;
	// submissions is a second table a write writes with target; properties is the table target's
	// parcel_id links to.
	target, strict, submissions, properties push.Table
	read                                    job.Job
	write                                   job.Job
	// sql writes a statement in the engine's words: {t} the table, {s} submissions, {p} properties,
	// {w} the counter's table.
	q func(statement string) string
}

// n reads one number: a count.
func (s *pushSite) n(t *testing.T, statement string) int64 {
	t.Helper()
	var n int64
	if err := s.owner.QueryRow(s.q(statement)).Scan(&n); err != nil {
		t.Fatalf("%s: %v", s.q(statement), err)
	}
	return n
}

func (s *pushSite) exec(t *testing.T, statement string) {
	t.Helper()
	exec(t, s.owner, s.q(statement))
}

// writes is how many rows the database's triggers counted inserted, updated or deleted.
func (s *pushSite) writes(t *testing.T) int64 {
	t.Helper()
	var n int64
	if err := s.owner.QueryRow(s.q("SELECT n FROM {w}")).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func pushDeps(t *testing.T, store push.Store) Deps {
	d := itDeps()
	d.NewRowsStore = func(job.Store, func(context.Context, time.Duration) error) push.Store { return store }
	d.Log = testLog{t}
	return d
}

// testLog is the runner's progress lines in the test's own log.
type testLog struct{ t *testing.T }

func (l testLog) Write(p []byte) (int, error) {
	l.t.Helper()
	l.t.Log(strings.TrimSpace(string(p)))
	return len(p), nil
}

// runRows runs a push or a compare data job for the store.
func runRows(t *testing.T, base job.Job, kind string, store *pushtest.Store) job.Output {
	t.Helper()
	j := base
	j.ID = randomName("dj_it_")
	j.Kind = kind
	j.Store = &job.Store{GatewayURL: "http://unused", StoreID: "sto_1", JobID: "job_1", Key: "k1.it"}
	j.Deadline = time.Now().Add(2 * time.Minute).Format(time.RFC3339Nano)
	return Run(context.Background(), j, pushDeps(t, store))
}

func mustRun(t *testing.T, base job.Job, kind string, store *pushtest.Store) {
	t.Helper()
	if out := runRows(t, base, kind, store); !out.OK {
		t.Fatalf("the %s job failed: %+v (the store heard %+v)", kind, out.Error, store.Failed)
	}
}

// pushScenario is the scenario every engine runs.
func pushScenario(t *testing.T, s *pushSite) {
	row := pushtest.Row
	columns := []string{"permit_no", "status", "fee", "issued_on", "_row"}
	// The database already holds BP-1 as the store does (its fee written its own way), and BP-9,
	// which this store never wrote.
	s.exec(t, "INSERT INTO {t} (permit_no, status, fee, issued_on) VALUES ('BP-1', 'Issued', 175.00, DATE '2026-01-02')")
	s.exec(t, "INSERT INTO {t} (permit_no, status, fee, issued_on) VALUES ('BP-9', 'Final', 10.00, DATE '2025-05-05')")
	source := [][]*string{
		row("BP-1", "Issued", "175", "2026-01-02", "1"),
		row("BP-2", "Final", "96.5", "2026-01-03", "2"),
		row("BP-3", "Issued", "<null>", "<null>", "3"),
		row("BP-4", "Pending", "12", "2026-02-01", "4"),
	}
	before := s.writes(t)

	// 1. The first preview: three new rows, BP-1 already there.
	preview := pushtest.New("push_preview", s.target, columns, source)
	preview.Removes = true
	mustRun(t, s.read, "compare", preview)
	if got := preview.Counts(); got["new"] != 3 || len(preview.Preview) != 3 {
		t.Fatalf("the first preview: %v", got)
	}
	if *preview.Ended.Same != 1 || *preview.Ended.TargetRows != 2 || *preview.Ended.Read != 4 {
		t.Fatalf("the first preview's counts: %+v", preview.Ended)
	}
	if _, ok := preview.Memory["BP-1"]; !ok {
		t.Fatalf("BP-1, already in the database, is not in the memory: %v", preview.Memory)
	}
	if s.writes(t) != before {
		t.Fatal("a preview wrote into the database")
	}

	// 2. Its write, in two batches: exactly three rows inserted.
	write := preview.ToPush()
	out := runRows(t, s.write, "push", write)
	if !out.OK {
		t.Fatalf("the write failed: %+v", out.Error)
	}
	result := out.Result.(*job.PushResult)
	if result.Inserted != 3 || result.Batches != 2 || result.Held != 0 {
		t.Fatalf("the write: %+v", result)
	}
	if got := s.writes(t) - before; got != 3 {
		t.Fatalf("the database counted %d rows written, want 3", got)
	}
	if len(write.Memory) != 4 {
		t.Fatalf("the memory after the write: %v", write.Memory)
	}

	// 3. Nothing changed: a preview sends nothing, and a write would write nothing.
	again := write.Again("push_preview")
	mustRun(t, s.read, "compare", again)
	if len(again.Preview) != 0 || *again.Ended.Same != 4 {
		t.Fatalf("a preview with nothing to do: %v, %+v", again.Counts(), again.Ended)
	}

	// 4. A person changes BP-2 in the database; the store changes BP-2 and BP-3, and drops BP-4.
	s.exec(t, "UPDATE {t} SET status = 'Void' WHERE permit_no = 'BP-2'")
	source = [][]*string{
		row("BP-1", "Issued", "175", "2026-01-02", "1"),
		row("BP-2", "Final", "99", "2026-01-03", "2"),
		row("BP-3", "Closed", "<null>", "<null>", "3"),
	}
	again.Source = source
	third := again.Again("push_preview")
	mustRun(t, s.read, "compare", third)
	got := third.Counts()
	if got["held"] != 1 || got["changed"] != 1 || got["removed"] != 1 || len(third.Preview) != 3 {
		t.Fatalf("the third preview: %v", got)
	}
	if held := third.Preview["BP-2"]; *held.Why != "changed_there" || held.Before == nil {
		t.Fatalf("BP-2 held: %+v", held)
	}
	if changed := third.Preview["BP-3"]; strings.Join(changed.Changed, ",") != s.name("status") {
		t.Fatalf("BP-3 changes %v", changed.Changed)
	}

	// 5. Between the preview and its write, a person changes BP-3's fee: it is held, and BP-4 deleted.
	s.exec(t, "UPDATE {t} SET fee = 1.00 WHERE permit_no = 'BP-3'")
	afterEdit := s.writes(t)
	write = third.ToPush()
	out = runRows(t, s.write, "push", write)
	if !out.OK {
		t.Fatalf("the second write failed: %+v", out.Error)
	}
	result = out.Result.(*job.PushResult)
	if result.Deleted != 1 || result.Held != 1 || result.Updated != 0 || result.Inserted != 0 {
		t.Fatalf("the second write: %+v", result)
	}
	if o := write.Outcomes["BP-3"]; o.Outcome != "held" || *o.Why != "since_preview" {
		t.Fatalf("BP-3 after the second write: %+v", o)
	}
	if got := s.writes(t) - afterEdit; got != 1 {
		t.Fatalf("the database counted %d rows written by the second write, want 1 (BP-4 deleted)", got)
	}
	var status string
	if err := s.owner.QueryRow(s.q("SELECT status FROM {t} WHERE permit_no = 'BP-2'")).Scan(&status); err != nil || status != "Void" {
		t.Fatalf("BP-2, changed by a person, was overwritten: %q %v", status, err)
	}

	// 6. A batch the database took and the store never heard of is written once.
	source = append(source, row("BP-5", "Issued", "5.25", "2026-03-01", "5"))
	write.Source = source
	fourth := write.Again("push_preview")
	mustRun(t, s.read, "compare", fourth)
	if fourth.Counts()["new"] != 1 {
		t.Fatalf("the fourth preview: %v", fourth.Counts())
	}
	beforeLost := s.writes(t)
	lost := fourth.ToPush()
	lost.FailSend = 1
	if out := runRows(t, s.write, "push", lost); out.OK || out.Error.Code != "store" {
		t.Fatalf("a write whose batch the store did not hear: %+v", out)
	}
	if _, ok := lost.Memory["BP-5"]; ok {
		t.Fatal("the store kept a batch it never heard of")
	}
	lost.FailSend = 0
	out = runRows(t, s.write, "push", lost)
	if !out.OK {
		t.Fatalf("the write after it: %+v", out.Error)
	}
	if result = out.Result.(*job.PushResult); result.Inserted != 1 {
		t.Fatalf("the write after it: %+v", result)
	}
	if got := s.writes(t) - beforeLost; got != 1 {
		t.Fatalf("the database counted %d rows written for BP-5, want 1", got)
	}
	if _, ok := lost.Memory["BP-5"]; !ok {
		t.Fatal("BP-5 is not in the memory after its write")
	}

	// 7. A compare: BP-2 and BP-3 differ, BP-1 and BP-5 match, and BP-9 is not this store's.
	compare := lost.Again("compare")
	mustRun(t, s.read, "compare", compare)
	if len(compare.Differences) != 2 || compare.Differences["BP-2"].Difference != "differs" || compare.Differences["BP-3"].Difference != "differs" {
		t.Fatalf("the compare: %+v", compare.Differences)
	}
	if *compare.Ended.Same != 2 || *compare.Ended.OtherRows != 1 || *compare.Ended.TargetRows != 5 {
		t.Fatalf("the compare's counts: %+v", compare.Ended)
	}

	// 8. A table whose new rows need a column the store's table lacks: the preview says which.
	strict := pushtest.New("push_preview", s.strict, columns, source)
	if out := runRows(t, s.read, "compare", strict); out.OK || !strings.Contains(out.Error.Message, s.name("parcel_id")) {
		t.Fatalf("a preview of a table needing parcel_id: %+v", out)
	}

	linksRehearsalUndo(t, s)
	twoTables(t, s)
}

// linksRehearsalUndo is the scenario's second store, whose permits name a parcel of town.properties:
// a preview counts the links its write cannot make, a rehearsal of its write leaves the database as it
// was, and the undo of its write puts back what the write did, except where the town changed a row
// since (the design's example).
func linksRehearsalUndo(t *testing.T, s *pushSite) {
	row := pushtest.Row
	columns := []string{"permit_no", "status", "fee", "issued_on", "parcel_id"}
	first := pushtest.New("push_preview", s.target, columns, [][]*string{
		row("BP-2026-0102", "Issued", "175", "2026-02-01", "P-404"),
		row("BP-2026-0103", "Issued", "60", "2026-02-02", "P-1"),
		row("BP-2026-0104", "Issued", "80", "2026-02-03", "<null>"),
	})
	mustRun(t, s.read, "compare", first)
	mustRun(t, s.write, "push", first.ToPush())
	// The town edits BP-2026-0103 since our last write.
	s.exec(t, "UPDATE {t} SET status = 'Void' WHERE permit_no = 'BP-2026-0103'")

	// 9. A preview counts its link: BP-2026-0101's parcel is there, BP-2026-0102's is not, and
	// BP-2026-0104 names none. BP-2026-0103 is held, so it is not counted.
	first.Source = [][]*string{
		row("BP-2026-0101", "Issued", "12", "2026-02-04", "P-1"),
		row("BP-2026-0102", "Closed", "175", "2026-02-01", "P-404"),
		row("BP-2026-0103", "Final", "60", "2026-02-02", "P-1"),
		row("BP-2026-0104", "Final", "80", "2026-02-03", "<null>"),
	}
	preview := first.Again("push_preview")
	preview.Links = []push.LinkSpec{{Column: s.name("parcel_id"), To: push.LinkTo{Schema: s.properties.Schema, Name: s.properties.Name, Column: s.name("parcel_id")}}}
	mustRun(t, s.read, "compare", preview)
	if got := preview.Counts(); got["new"] != 1 || got["changed"] != 2 || got["held"] != 1 {
		t.Fatalf("the preview of the second store: %v", got)
	}
	want := []push.LinkCount{{Column: s.name("parcel_id"), To: s.properties.Schema + "." + s.properties.Name + "." + s.name("parcel_id"), Linked: 1, Unlinked: 1, Empty: 1}}
	if !reflect.DeepEqual(preview.Ended.Links, want) {
		t.Fatalf("the link's counts: %+v, want %+v", preview.Ended.Links, want)
	}
	if got := preview.Preview["BP-2026-0102"].Unlinked; strings.Join(got, ",") != s.name("parcel_id") || preview.Preview["BP-2026-0101"].Unlinked != nil {
		t.Fatalf("the unlinked rows: %v and %v", got, preview.Preview["BP-2026-0101"].Unlinked)
	}
	// A link to a table that is not there fails a preview by the table's name.
	nowhere := preview.Again("push_preview")
	nowhere.Links = []push.LinkSpec{{Column: s.name("parcel_id"), To: push.LinkTo{Schema: s.properties.Schema, Name: s.name("no_such_parcels"), Column: s.name("parcel_id")}}}
	if out := runRows(t, s.read, "compare", nowhere); out.OK || out.Error.Code != "database" || !strings.Contains(out.Error.Message, s.name("no_such_parcels")) || nowhere.Page != 0 {
		t.Fatalf("a link to a table that is not there: %+v", out)
	}

	// 10. Its rehearsal writes the three rows in one transaction and rolls it back: the database and
	// the store's memory are as they were, and every row read back holds what it held before.
	before := s.writes(t)
	memory := maps.Clone(preview.Memory)
	rehearsal := preview.ToPush()
	rehearsal.Rehearse = true
	out := runRows(t, s.write, "push", rehearsal)
	if !out.OK {
		t.Fatalf("the rehearsal failed: %+v", out.Error)
	}
	if got := s.writes(t); got != before {
		t.Fatalf("the rehearsal left %d rows written", got-before)
	}
	if s.n(t, "SELECT COUNT(*) FROM {t} WHERE permit_no = 'BP-2026-0101'") != 0 || s.n(t, "SELECT COUNT(*) FROM {t} WHERE permit_no = 'BP-2026-0102' AND status = 'Issued'") != 1 {
		t.Fatal("the rehearsal changed the table")
	}
	if !reflect.DeepEqual(rehearsal.Memory, memory) || !rehearsal.Ended.RolledBack || *rehearsal.Restored != 3 || len(rehearsal.Manifest) != 3 {
		t.Fatalf("the rehearsal: the store heard %+v, its manifest %+v", rehearsal.Ended, rehearsal.Manifest)
	}
	if m := rehearsal.Manifest["BP-2026-0102"]; *m.Did != "updated" || strings.Join(m.Set, ",") != s.name("status") || *m.Before[1] != "Issued" || *m.After[1] != "Closed" {
		t.Fatalf("BP-2026-0102 in the manifest: %+v", m)
	}
	if m := rehearsal.Manifest["BP-2026-0101"]; *m.Did != "inserted" || m.After == nil || *m.After[0] != "BP-2026-0101" {
		t.Fatalf("BP-2026-0101 in the manifest: %+v", m)
	}

	// 11. Its write, for real: BP-2026-0101 inserted, BP-2026-0102 and BP-2026-0104 changed. Then the
	// town changes BP-2026-0104's fee.
	write := preview.ToPush()
	out = runRows(t, s.write, "push", write)
	if !out.OK {
		t.Fatalf("the write of the second store failed: %+v", out.Error)
	}
	if result := out.Result.(*job.PushResult); result.Inserted != 1 || result.Updated != 2 || s.writes(t)-before != 3 {
		t.Fatalf("the write of the second store: %+v, %d rows written", result, s.writes(t)-before)
	}
	s.exec(t, "UPDATE {t} SET fee = 81.00 WHERE permit_no = 'BP-2026-0104'")
	beforeUndo := s.writes(t)

	// 12. Its undo removes BP-2026-0101 and puts BP-2026-0102's status back, in one transaction. It
	// holds BP-2026-0104, which the town changed since, and never touches BP-2026-0103.
	undo := write.Undo()
	out = runRows(t, s.write, "push", undo)
	if !out.OK {
		t.Fatalf("the undo failed: %+v", out.Error)
	}
	if result := out.Result.(*job.PushResult); result.Deleted != 1 || result.Updated != 1 || result.Inserted != 0 || result.Held != 1 {
		t.Fatalf("the undo: %+v", result)
	}
	if got := s.writes(t) - beforeUndo; got != 2 {
		t.Fatalf("the database counted %d rows written by the undo, want 2", got)
	}
	if want := map[string]string{"BP-2026-0101": "undone", "BP-2026-0102": "undone", "BP-2026-0104": "held"}; !reflect.DeepEqual(undo.Undone[0], want) {
		t.Fatalf("the undo's rows: %v", undo.Undone[0])
	}
	if s.n(t, "SELECT COUNT(*) FROM {t} WHERE permit_no = 'BP-2026-0101'") != 0 ||
		s.n(t, "SELECT COUNT(*) FROM {t} WHERE permit_no = 'BP-2026-0102' AND status = 'Issued' AND fee = 175") != 1 ||
		s.n(t, "SELECT COUNT(*) FROM {t} WHERE permit_no = 'BP-2026-0103' AND status = 'Void'") != 1 ||
		s.n(t, "SELECT COUNT(*) FROM {t} WHERE permit_no = 'BP-2026-0104' AND status = 'Final' AND fee = 81") != 1 {
		t.Fatal("the table after the undo is not as the write found it")
	}
	if _, kept := write.Memory["BP-2026-0101"]; kept || write.Memory["BP-2026-0102"] != memory["BP-2026-0102"] {
		t.Fatalf("the memory after the undo: %v", write.Memory)
	}
}

// twoTables writes two tables in one transaction: a row the second refuses leaves nothing of the
// first, and once it is fixed both are written.
func twoTables(t *testing.T, s *pushSite) {
	row := pushtest.Row
	permits := pushtest.New("push_preview", s.target, []string{"permit_no", "status", "fee", "issued_on"}, [][]*string{
		row("BP-2026-0201", "Issued", "10", "2026-03-01"),
		row("BP-2026-0202", "Issued", "20", "2026-03-02"),
	})
	columns := []string{"submission_id", "permit_no", "received", "reference_no"}
	// Two submissions of one reference: the table holds each reference once.
	received := pushtest.New("push_preview", s.submissions, columns, [][]*string{
		row("S-1", "BP-2026-0201", "2026-03-03", "REF-DUP-7"),
		row("S-2", "BP-2026-0202", "2026-03-04", "REF-DUP-7"),
	})
	mustRun(t, s.read, "compare", permits)
	mustRun(t, s.read, "compare", received)
	before := s.writes(t)

	// 13. The second table refuses a row: nothing of the first stays, and the error names no value.
	refused := permits.ToPushWith(received)
	out := runRows(t, s.write, "push", refused)
	if out.OK || out.Error.Code != "database" || strings.Contains(out.Error.Message, "REF-DUP-7") || refused.Page != 1 {
		t.Fatalf("a write whose second table refused a row: %+v, page %d", out, refused.Page)
	}
	if got := s.writes(t); got != before || s.n(t, "SELECT COUNT(*) FROM {t} WHERE permit_no LIKE 'BP-2026-02%'") != 0 || s.n(t, "SELECT COUNT(*) FROM {s}") != 0 {
		t.Fatalf("a refused write of two tables left %d rows written", got-before)
	}
	if len(permits.Memory) != 0 || len(received.Memory) != 0 {
		t.Fatalf("the store kept a write the database rolled back: %v %v", permits.Memory, received.Memory)
	}

	// 14. Fixed, the two are written in one transaction: two permits, then their two submissions.
	received.Source[1][3] = pushtest.Str("REF-8")
	fixed := received.Again("push_preview")
	mustRun(t, s.read, "compare", fixed)
	write := permits.ToPushWith(fixed)
	out = runRows(t, s.write, "push", write)
	if !out.OK {
		t.Fatalf("the write of two tables failed: %+v", out.Error)
	}
	if result := out.Result.(*job.PushResult); result.Inserted != 4 || result.Batches != 2 || s.writes(t)-before != 4 {
		t.Fatalf("the write of two tables: %+v, %d rows written", result, s.writes(t)-before)
	}
	if !write.Ended.Committed || len(permits.Memory) != 2 || len(fixed.Memory) != 2 || s.n(t, "SELECT COUNT(*) FROM {s}") != 2 {
		t.Fatalf("after the write of two tables: the store heard %+v, memory %v %v", write.Ended, permits.Memory, fixed.Memory)
	}
}

// name is a column's name as the engine keeps it: Oracle's in capitals.
func (s *pushSite) name(n string) string {
	if s.engine == "oracle" {
		return strings.ToUpper(n)
	}
	return n
}

func TestMySQLPushForReal(t *testing.T) {
	admin := os.Getenv("DATA_RUNNER_IT_MYSQL")
	if admin == "" {
		t.Skip("DATA_RUNNER_IT_MYSQL is not set")
	}
	root, err := sql.Open("mysql", admin)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ready(t, root)
	host, port := "127.0.0.1", 3306
	if i := strings.Index(admin, "tcp("); i >= 0 {
		addr := admin[i+4 : strings.Index(admin[i:], ")")+i]
		h, p, _ := strings.Cut(addr, ":")
		host, port = hostPort(t, h, p, 3306)
	}
	name := randomName("dr_push_")
	readPW, writePW := itPassword(), itPassword()
	exec(t, root, "CREATE DATABASE "+name,
		"CREATE TABLE "+name+".permits (permit_no VARCHAR(40) NOT NULL PRIMARY KEY, status VARCHAR(20) NOT NULL, fee DECIMAL(10,2), issued_on DATE, edited_by VARCHAR(40), parcel_id VARCHAR(20))",
		"CREATE TABLE "+name+".strict_permits (permit_no VARCHAR(40) NOT NULL PRIMARY KEY, status VARCHAR(20), fee DECIMAL(10,2), issued_on DATE, parcel_id VARCHAR(20) NOT NULL)",
		"CREATE TABLE "+name+".submissions (submission_id VARCHAR(40) NOT NULL PRIMARY KEY, permit_no VARCHAR(40) NOT NULL, received DATE, reference_no VARCHAR(40) NOT NULL UNIQUE)",
		"CREATE TABLE "+name+".properties (parcel_id VARCHAR(20) NOT NULL PRIMARY KEY, holder VARCHAR(40))",
		"INSERT INTO "+name+".properties VALUES ('P-1', 'A. Holder'), ('P-2', 'B. Holder')",
		"CREATE TABLE "+name+".push_writes (n INT NOT NULL)",
		"INSERT INTO "+name+".push_writes VALUES (0)",
		"CREATE TRIGGER "+name+".permits_i AFTER INSERT ON "+name+".permits FOR EACH ROW UPDATE "+name+".push_writes SET n = n + 1",
		"CREATE TRIGGER "+name+".permits_u AFTER UPDATE ON "+name+".permits FOR EACH ROW UPDATE "+name+".push_writes SET n = n + 1",
		"CREATE TRIGGER "+name+".permits_d AFTER DELETE ON "+name+".permits FOR EACH ROW UPDATE "+name+".push_writes SET n = n + 1",
		"CREATE TRIGGER "+name+".submissions_i AFTER INSERT ON "+name+".submissions FOR EACH ROW UPDATE "+name+".push_writes SET n = n + 1",
		"CREATE TRIGGER "+name+".submissions_u AFTER UPDATE ON "+name+".submissions FOR EACH ROW UPDATE "+name+".push_writes SET n = n + 1",
		"CREATE TRIGGER "+name+".submissions_d AFTER DELETE ON "+name+".submissions FOR EACH ROW UPDATE "+name+".push_writes SET n = n + 1",
		"CREATE USER '"+name+"_r'@'%' IDENTIFIED BY '"+readPW+"'",
		"CREATE USER '"+name+"_w'@'%' IDENTIFIED BY '"+writePW+"'",
		"GRANT SELECT ON "+name+".* TO '"+name+"_r'@'%'",
		"GRANT SELECT ON "+name+".* TO '"+name+"_w'@'%'",
		"GRANT INSERT, UPDATE, DELETE ON "+name+".permits TO '"+name+"_w'@'%'",
		"GRANT INSERT, UPDATE, DELETE ON "+name+".submissions TO '"+name+"_w'@'%'")
	defer exec(t, root, "DROP DATABASE IF EXISTS "+name, "DROP USER IF EXISTS '"+name+"_r'@'%'", "DROP USER IF EXISTS '"+name+"_w'@'%'")
	writer := itJob("mysql", name, host, port, name+"_w", writePW, tlsFor("mysql"))
	writer.Login.Kind = "write"
	site := &pushSite{
		engine: "mysql", owner: root,
		target: push.Table{Schema: name, Name: "permits"}, strict: push.Table{Schema: name, Name: "strict_permits"},
		submissions: push.Table{Schema: name, Name: "submissions"}, properties: push.Table{Schema: name, Name: "properties"},
		read:  itJob("mysql", name, host, port, name+"_r", readPW, tlsFor("mysql")),
		write: writer,
		q: func(statement string) string {
			return strings.NewReplacer("{t}", name+".permits", "{s}", name+".submissions", "{p}", name+".properties", "{w}", name+".push_writes").Replace(statement)
		},
	}
	pushScenario(t, site)

	// A MyISAM table's changes do not roll back: a rehearsal there is refused by its name, and writes
	// nothing.
	exec(t, root, "CREATE TABLE "+name+".archived_permits (permit_no VARCHAR(40) NOT NULL PRIMARY KEY, status VARCHAR(20) NOT NULL) ENGINE=MyISAM",
		"GRANT INSERT, UPDATE, DELETE ON "+name+".archived_permits TO '"+name+"_w'@'%'")
	archived := push.Table{Schema: name, Name: "archived_permits"}
	preview := pushtest.New("push_preview", archived, []string{"permit_no", "status"}, [][]*string{pushtest.Row("BP-1", "Issued")})
	mustRun(t, site.read, "compare", preview)
	rehearsal := preview.ToPush()
	rehearsal.Rehearse = true
	out := runRows(t, site.write, "push", rehearsal)
	if out.OK || out.Error.Code != "database" || !strings.Contains(out.Error.Message, name+".archived_permits is a MyISAM table") || rehearsal.BegunAgain != 0 {
		t.Fatalf("a rehearsal on a MyISAM table: %+v", out)
	}
	if site.n(t, "SELECT COUNT(*) FROM "+name+".archived_permits") != 0 {
		t.Fatal("the refused rehearsal wrote into the MyISAM table")
	}
}

func TestPostgresPushForReal(t *testing.T) {
	admin := os.Getenv("DATA_RUNNER_IT_POSTGRES")
	if admin == "" {
		t.Skip("DATA_RUNNER_IT_POSTGRES is not set")
	}
	u, err := url.Parse(admin)
	if err != nil {
		t.Fatal(err)
	}
	host, port := hostPort(t, u.Hostname(), u.Port(), 5432)
	root, err := sql.Open("pgx", admin)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ready(t, root)
	name := randomName("dr_push_")
	readPW, writePW := itPassword(), itPassword()
	exec(t, root, "CREATE DATABASE "+name, "CREATE ROLE "+name+"_r LOGIN PASSWORD '"+readPW+"'", "CREATE ROLE "+name+"_w LOGIN PASSWORD '"+writePW+"'")
	defer exec(t, root, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)", "DROP ROLE IF EXISTS "+name+"_r", "DROP ROLE IF EXISTS "+name+"_w")
	u.Path = "/" + name
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec(t, db,
		"CREATE TABLE permits (permit_no varchar(40) NOT NULL PRIMARY KEY, status varchar(20) NOT NULL, fee numeric(10,2), issued_on date, edited_by varchar(40), parcel_id varchar(20))",
		"CREATE TABLE strict_permits (permit_no varchar(40) NOT NULL PRIMARY KEY, status varchar(20), fee numeric(10,2), issued_on date, parcel_id varchar(20) NOT NULL)",
		"CREATE TABLE submissions (submission_id varchar(40) NOT NULL PRIMARY KEY, permit_no varchar(40) NOT NULL, received date, reference_no varchar(40) NOT NULL UNIQUE)",
		"CREATE TABLE properties (parcel_id varchar(20) NOT NULL PRIMARY KEY, holder varchar(40))",
		"INSERT INTO properties VALUES ('P-1', 'A. Holder'), ('P-2', 'B. Holder')",
		"CREATE TABLE push_writes (n int NOT NULL)",
		"INSERT INTO push_writes VALUES (0)",
		"CREATE FUNCTION count_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN UPDATE push_writes SET n = n + 1; RETURN NULL; END $$",
		"CREATE TRIGGER permits_count AFTER INSERT OR UPDATE OR DELETE ON permits FOR EACH ROW EXECUTE FUNCTION count_write()",
		"CREATE TRIGGER submissions_count AFTER INSERT OR UPDATE OR DELETE ON submissions FOR EACH ROW EXECUTE FUNCTION count_write()",
		"GRANT USAGE ON SCHEMA public TO "+name+"_r, "+name+"_w",
		"GRANT SELECT ON ALL TABLES IN SCHEMA public TO "+name+"_r, "+name+"_w",
		"GRANT INSERT, UPDATE, DELETE ON permits, submissions TO "+name+"_w")
	writer := itJob("postgres", name, host, port, name+"_w", writePW, tlsFor("postgres"))
	writer.Login.Kind = "write"
	pushScenario(t, &pushSite{
		engine: "postgres", owner: db,
		target: push.Table{Schema: "public", Name: "permits"}, strict: push.Table{Schema: "public", Name: "strict_permits"},
		submissions: push.Table{Schema: "public", Name: "submissions"}, properties: push.Table{Schema: "public", Name: "properties"},
		read:  itJob("postgres", name, host, port, name+"_r", readPW, tlsFor("postgres")),
		write: writer,
		q: func(statement string) string {
			return strings.NewReplacer("{t}", "permits", "{s}", "submissions", "{p}", "properties", "{w}", "push_writes").Replace(statement)
		},
	})
}

func TestSQLServerPushForReal(t *testing.T) {
	admin := os.Getenv("DATA_RUNNER_IT_MSSQL")
	if admin == "" {
		t.Skip("DATA_RUNNER_IT_MSSQL is not set")
	}
	u, err := url.Parse(admin)
	if err != nil {
		t.Fatal(err)
	}
	host, port := hostPort(t, u.Hostname(), u.Port(), 1433)
	root, err := sql.Open("sqlserver", admin)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ready(t, root)
	name := randomName("dr_push_")
	readPW, writePW := itPassword(), itPassword()
	exec(t, root, "CREATE DATABASE "+name,
		"CREATE LOGIN "+name+"_r WITH PASSWORD = '"+readPW+"', CHECK_POLICY = OFF",
		"CREATE LOGIN "+name+"_w WITH PASSWORD = '"+writePW+"', CHECK_POLICY = OFF")
	defer exec(t, root, "ALTER DATABASE "+name+" SET SINGLE_USER WITH ROLLBACK IMMEDIATE", "DROP DATABASE "+name, "DROP LOGIN "+name+"_r", "DROP LOGIN "+name+"_w")
	q := u.Query()
	q.Set("database", name)
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlserver", u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	exec(t, db,
		"CREATE TABLE dbo.permits (permit_no NVARCHAR(40) NOT NULL PRIMARY KEY, status NVARCHAR(20) NOT NULL, fee DECIMAL(10,2), issued_on DATE, edited_by NVARCHAR(40), parcel_id NVARCHAR(20))",
		"CREATE TABLE dbo.strict_permits (permit_no NVARCHAR(40) NOT NULL PRIMARY KEY, status NVARCHAR(20), fee DECIMAL(10,2), issued_on DATE, parcel_id NVARCHAR(20) NOT NULL)",
		"CREATE TABLE dbo.submissions (submission_id NVARCHAR(40) NOT NULL PRIMARY KEY, permit_no NVARCHAR(40) NOT NULL, received DATE, reference_no NVARCHAR(40) NOT NULL UNIQUE)",
		"CREATE TABLE dbo.properties (parcel_id NVARCHAR(20) NOT NULL PRIMARY KEY, holder NVARCHAR(40))",
		"INSERT INTO dbo.properties VALUES ('P-1', 'A. Holder'), ('P-2', 'B. Holder')",
		"CREATE TABLE dbo.push_writes (n INT NOT NULL)",
		"INSERT INTO dbo.push_writes VALUES (0)",
		`CREATE TRIGGER dbo.permits_count ON dbo.permits AFTER INSERT, UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.push_writes SET n = n + CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN (SELECT COUNT(*) FROM inserted) ELSE (SELECT COUNT(*) FROM deleted) END;
END`,
		`CREATE TRIGGER dbo.submissions_count ON dbo.submissions AFTER INSERT, UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.push_writes SET n = n + CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN (SELECT COUNT(*) FROM inserted) ELSE (SELECT COUNT(*) FROM deleted) END;
END`,
		"CREATE USER "+name+"_r FOR LOGIN "+name+"_r",
		"CREATE USER "+name+"_w FOR LOGIN "+name+"_w",
		"GRANT SELECT TO "+name+"_r",
		"GRANT SELECT TO "+name+"_w",
		"GRANT INSERT, UPDATE, DELETE ON dbo.permits TO "+name+"_w",
		"GRANT INSERT, UPDATE, DELETE ON dbo.submissions TO "+name+"_w")
	writer := itJob("sqlserver", name, host, port, name+"_w", writePW, tlsFor("sqlserver"))
	writer.Login.Kind = "write"
	pushScenario(t, &pushSite{
		engine: "sqlserver", owner: db,
		target: push.Table{Schema: "dbo", Name: "permits"}, strict: push.Table{Schema: "dbo", Name: "strict_permits"},
		submissions: push.Table{Schema: "dbo", Name: "submissions"}, properties: push.Table{Schema: "dbo", Name: "properties"},
		read:  itJob("sqlserver", name, host, port, name+"_r", readPW, tlsFor("sqlserver")),
		write: writer,
		q: func(statement string) string {
			// SQL Server's date literal is a string.
			statement = strings.ReplaceAll(statement, "DATE '", "'")
			return strings.NewReplacer("{t}", "dbo.permits", "{s}", "dbo.submissions", "{p}", "dbo.properties", "{w}", "dbo.push_writes").Replace(statement)
		},
	})
}

func TestOraclePushForReal(t *testing.T) {
	admin := os.Getenv("DATA_RUNNER_IT_ORACLE")
	if admin == "" {
		t.Skip("DATA_RUNNER_IT_ORACLE is not set")
	}
	u, err := url.Parse(admin)
	if err != nil {
		t.Fatal(err)
	}
	host, port := hostPort(t, u.Hostname(), u.Port(), 1521)
	service := strings.TrimPrefix(u.Path, "/")
	root, err := sql.Open("oracle", admin)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ready(t, root)
	owner := strings.ToUpper(randomName("DR_PUSH_"))
	ownerPW, readPW, writePW := itPassword(), itPassword(), itPassword()
	exec(t, root,
		`CREATE USER `+owner+` IDENTIFIED BY "`+ownerPW+`" QUOTA UNLIMITED ON USERS`,
		`GRANT CREATE SESSION, CREATE TABLE, CREATE TRIGGER TO `+owner,
		`CREATE USER `+owner+`_R IDENTIFIED BY "`+readPW+`"`,
		`GRANT CREATE SESSION TO `+owner+`_R`,
		`CREATE USER `+owner+`_W IDENTIFIED BY "`+writePW+`"`,
		`GRANT CREATE SESSION TO `+owner+`_W`)
	defer exec(t, root, "DROP USER "+owner+"_R CASCADE", "DROP USER "+owner+"_W CASCADE", "DROP USER "+owner+" CASCADE")
	ou := *u
	ou.User = url.UserPassword(owner, ownerPW)
	db, err := sql.Open("oracle", ou.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec(t, db,
		"CREATE TABLE PERMITS (PERMIT_NO VARCHAR2(40) NOT NULL PRIMARY KEY, STATUS VARCHAR2(20) NOT NULL, FEE NUMBER(10,2), ISSUED_ON DATE, EDITED_BY VARCHAR2(40), PARCEL_ID VARCHAR2(20))",
		"CREATE TABLE STRICT_PERMITS (PERMIT_NO VARCHAR2(40) NOT NULL PRIMARY KEY, STATUS VARCHAR2(20), FEE NUMBER(10,2), ISSUED_ON DATE, PARCEL_ID VARCHAR2(20) NOT NULL)",
		"CREATE TABLE SUBMISSIONS (SUBMISSION_ID VARCHAR2(40) NOT NULL PRIMARY KEY, PERMIT_NO VARCHAR2(40) NOT NULL, RECEIVED DATE, REFERENCE_NO VARCHAR2(40) NOT NULL UNIQUE)",
		"CREATE TABLE PROPERTIES (PARCEL_ID VARCHAR2(20) NOT NULL PRIMARY KEY, HOLDER VARCHAR2(40))",
		"INSERT INTO PROPERTIES VALUES ('P-1', 'A. Holder')",
		"INSERT INTO PROPERTIES VALUES ('P-2', 'B. Holder')",
		"CREATE TABLE PUSH_WRITES (N NUMBER(10) NOT NULL)",
		"INSERT INTO PUSH_WRITES VALUES (0)",
		"CREATE TRIGGER PERMITS_COUNT AFTER INSERT OR UPDATE OR DELETE ON PERMITS FOR EACH ROW BEGIN UPDATE PUSH_WRITES SET N = N + 1; END;",
		"CREATE TRIGGER SUBMISSIONS_COUNT AFTER INSERT OR UPDATE OR DELETE ON SUBMISSIONS FOR EACH ROW BEGIN UPDATE PUSH_WRITES SET N = N + 1; END;",
		"GRANT SELECT ON PERMITS TO "+owner+"_R",
		"GRANT SELECT ON STRICT_PERMITS TO "+owner+"_R",
		"GRANT SELECT ON SUBMISSIONS TO "+owner+"_R",
		"GRANT SELECT ON PROPERTIES TO "+owner+"_R",
		"GRANT SELECT, INSERT, UPDATE, DELETE ON PERMITS TO "+owner+"_W",
		"GRANT SELECT, INSERT, UPDATE, DELETE ON SUBMISSIONS TO "+owner+"_W")
	writer := itJob("oracle", service, host, port, owner+"_W", writePW, tlsFor("oracle"))
	writer.Login.Kind = "write"
	pushScenario(t, &pushSite{
		engine: "oracle", owner: db,
		target: push.Table{Schema: owner, Name: "PERMITS"}, strict: push.Table{Schema: owner, Name: "STRICT_PERMITS"},
		submissions: push.Table{Schema: owner, Name: "SUBMISSIONS"}, properties: push.Table{Schema: owner, Name: "PROPERTIES"},
		read:  itJob("oracle", service, host, port, owner+"_R", readPW, tlsFor("oracle")),
		write: writer,
		q: func(statement string) string {
			return strings.NewReplacer("{t}", "PERMITS", "{s}", "SUBMISSIONS", "{p}", "PROPERTIES", "{w}", "PUSH_WRITES").Replace(statement)
		},
	})
}
