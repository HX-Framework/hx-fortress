package pull

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
)

func ptr(s string) *string { return &s }

// fakeStore is the store's side: it keeps what a real store keeps of each table (each row's key and
// hash), takes pages in order, and counts what it was sent.
type fakeStore struct {
	state      string
	waitsLeft  int
	mode       string
	startPage  int64
	limits     Limits
	sources    []Source
	into       []string
	held       map[string]string // what the store holds of table 0: key to hash
	pageCalls  int
	rowsSent   int
	sent       map[string][]*string
	removed    []string
	ends       []EndBody
	begins     []BeginBody
	nextPage   map[int]int64
	failed     *FailBody
	pageErr    error
	hashesRead int
	refuseKey  bool
}

func (s *fakeStore) State(context.Context) (State, error) {
	if s.waitsLeft > 0 {
		s.waitsLeft--
		return State{State: "waiting", Limits: s.limits}, nil
	}
	if s.state != "" {
		return State{State: s.state, Limits: s.limits}, nil
	}
	tables := make([]TableState, len(s.sources))
	for i, source := range s.sources {
		tables[i] = TableState{Source: source, Into: s.into[i]}
	}
	return State{State: "taking", Tables: tables, Limits: s.limits}, nil
}

func (s *fakeStore) Begin(_ context.Context, body BeginBody) (BeginAnswer, error) {
	if s.refuseKey {
		return BeginAnswer{}, &StoreError{Status: 403, Code: "job_key_refused", Message: "A newer data job holds this pull's key."}
	}
	s.begins = append(s.begins, body)
	return BeginAnswer{Mode: s.mode, Page: s.startPage}, nil
}

func (s *fakeStore) Hashes(_ context.Context, body HashesBody) (HashesAnswer, error) {
	s.hashesRead++
	keys := make([]string, 0, len(s.held))
	for k := range s.held {
		if body.After == nil || k > *body.After {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	answer := HashesAnswer{Hashes: [][2]string{}}
	for _, k := range keys {
		if len(answer.Hashes) == 2 { // two a read, so paging is exercised
			last := answer.Hashes[1][0]
			answer.Next = &last
			break
		}
		answer.Hashes = append(answer.Hashes, [2]string{k, s.held[k]})
	}
	return answer, nil
}

func (s *fakeStore) Page(_ context.Context, table int, page int64, rowsJSON []byte, removed []string) (PageAnswer, error) {
	if s.pageErr != nil {
		return PageAnswer{}, s.pageErr
	}
	if s.nextPage == nil {
		s.nextPage = map[int]int64{}
	}
	want := s.nextPage[table]
	if want == 0 {
		want = s.startPage + 1
	}
	if page != want {
		return PageAnswer{}, fmt.Errorf("page %d out of order, wanted %d", page, want)
	}
	s.nextPage[table] = page + 1
	s.pageCalls++
	var rows [][]*string
	if len(rowsJSON) > 0 {
		if err := json.Unmarshal(append(append([]byte{'['}, rowsJSON...), ']'), &rows); err != nil {
			return PageAnswer{}, err
		}
	}
	if s.sent == nil {
		s.sent = map[string][]*string{}
	}
	for _, row := range rows {
		s.rowsSent++
		s.sent[*row[0]] = row
	}
	s.removed = append(s.removed, removed...)
	return PageAnswer{Page: page, Taken: true}, nil
}

func (s *fakeStore) End(_ context.Context, body EndBody) (EndAnswer, error) {
	s.ends = append(s.ends, body)
	return EndAnswer{}, nil
}

func (s *fakeStore) Fail(_ context.Context, body FailBody) error {
	s.failed = &body
	return nil
}

type fakeDB struct {
	columns []engine.Column
	key     []string
	rows    [][]*string
	readErr error
	reads   int
}

func (d *fakeDB) Describe(context.Context, Source) ([]engine.Column, []string, error) {
	return d.columns, d.key, nil
}

func (d *fakeDB) Read(context.Context, Source, []engine.Column) (Rows, error) {
	d.reads++
	if d.readErr != nil {
		return nil, d.readErr
	}
	return &fakeRows{rows: d.rows}, nil
}

type fakeRows struct {
	rows [][]*string
	at   int
}

func (r *fakeRows) Next() bool                 { r.at++; return r.at <= len(r.rows) }
func (r *fakeRows) Values() ([]*string, error) { return append([]*string{}, r.rows[r.at-1]...), nil }
func (r *fakeRows) Err() error                 { return nil }
func (r *fakeRows) Close() error               { return nil }

func deps(s *fakeStore, d *fakeDB) Deps {
	return Deps{
		Store:    s,
		Database: d,
		Classify: func(err error, doing string) *job.Error { return job.Fail("database", "Could not %s: %s", doing, err) },
		Now:      time.Now,
		Sleep:    func(context.Context, time.Duration) error { return nil },
		Logf:     func(string, ...any) {},
	}
}

func newStore() *fakeStore {
	return &fakeStore{
		mode:    "new",
		limits:  Limits{PageRows: 2, PageBytes: 1 << 20, HashRows: 2, RowBytes: 1 << 20, Removed: 2},
		sources: []Source{{Schema: "public", Name: "permits"}},
		into:    []string{"permits"},
		held:    map[string]string{},
	}
}

func newDB() *fakeDB {
	return &fakeDB{
		columns: []engine.Column{engine.NewColumn("permit_no", "text"), engine.NewColumn("status", "text")},
		key:     []string{"permit_no"},
		rows: [][]*string{
			{ptr("A1"), ptr("Issued")},
			{ptr("A2"), ptr("Final")},
			{ptr("A3"), nil},
			{ptr("A4"), ptr("Issued")},
			{ptr("A5"), ptr("Void")},
		},
	}
}

func TestAFirstPullSendsEveryRowInPages(t *testing.T) {
	s, d := newStore(), newDB()
	tables, failure := Run(context.Background(), deps(s, d))
	if failure != nil {
		t.Fatal(failure)
	}
	if s.rowsSent != 5 || s.pageCalls != 3 || s.hashesRead != 0 {
		t.Fatalf("sent %d rows in %d pages, read hashes %d times", s.rowsSent, s.pageCalls, s.hashesRead)
	}
	if len(s.ends) != 1 || s.ends[0].Read != 5 || s.ends[0].Cut != 0 {
		t.Fatalf("ends: %+v", s.ends)
	}
	want := job.PulledTable{Source: "public.permits", Into: "permits", Mode: "new", Read: 5, Sent: 5, Removed: 0, Pages: 3}
	got := tables[0]
	got.MS = 0
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("result %+v", got)
	}
	row := s.sent["A3"]
	if len(row) != 4 || *row[0] != "A3" || row[3] != nil || *row[1] != RowHash([]*string{ptr("A3"), nil}) {
		t.Fatalf("row %+v", row)
	}
}

func TestASecondPullSendsOnlyWhatChanged(t *testing.T) {
	s, d := newStore(), newDB()
	s.mode = "change"
	// The store holds A1, A2, A3 and A4 as they were, and A9, which the database no longer has.
	for _, row := range d.rows[:4] {
		s.held[*row[0]] = RowHash(row)
	}
	s.held["A9"] = "0123456789abcdef"
	// Tonight, A2 changed.
	d.rows[1][1] = ptr("Withdrawn")
	tables, failure := Run(context.Background(), deps(s, d))
	if failure != nil {
		t.Fatal(failure)
	}
	if s.rowsSent != 2 {
		t.Fatalf("sent %d rows: %v", s.rowsSent, s.sent)
	}
	if _, ok := s.sent["A2"]; !ok {
		t.Fatal("A2, which changed, was not sent")
	}
	if _, ok := s.sent["A5"]; !ok {
		t.Fatal("A5, which is new, was not sent")
	}
	if !reflect.DeepEqual(s.removed, []string{"A9"}) {
		t.Fatalf("removed %v", s.removed)
	}
	got := tables[0]
	if got.Read != 5 || got.Sent != 2 || got.Removed != 1 || got.Mode != "change" {
		t.Fatalf("result %+v", got)
	}
	if s.hashesRead < 3 {
		t.Fatalf("read the store's hashes in %d reads; two a read should need three", s.hashesRead)
	}
}

func TestAnUnchangedTableSendsNoPage(t *testing.T) {
	s, d := newStore(), newDB()
	s.mode = "change"
	for _, row := range d.rows {
		s.held[*row[0]] = RowHash(row)
	}
	tables, failure := Run(context.Background(), deps(s, d))
	if failure != nil {
		t.Fatal(failure)
	}
	if s.pageCalls != 0 || s.rowsSent != 0 || len(s.ends) != 1 || tables[0].Sent != 0 || tables[0].Pages != 0 {
		t.Fatalf("pages %d, rows %d, ends %d, result %+v", s.pageCalls, s.rowsSent, len(s.ends), tables[0])
	}
}

func TestAStoppedPullGoesOnFromTheStoresPages(t *testing.T) {
	s, d := newStore(), newDB()
	// An earlier data job got two rows into a new version, in one page.
	s.mode, s.startPage = "new", 1
	for _, row := range d.rows[:2] {
		s.held[*row[0]] = RowHash(row)
	}
	tables, failure := Run(context.Background(), deps(s, d))
	if failure != nil {
		t.Fatal(failure)
	}
	if s.rowsSent != 3 || s.hashesRead == 0 {
		t.Fatalf("sent %d rows, hashes read %d times", s.rowsSent, s.hashesRead)
	}
	if tables[0].Pages != 2 || s.nextPage[0] != 4 {
		t.Fatalf("pages %d, next page %d", tables[0].Pages, s.nextPage[0])
	}
}

func TestATableThatEndedInAnEarlierJobIsSkipped(t *testing.T) {
	s, d := newStore(), newDB()
	tables := []TableState{{Source: s.sources[0], Into: "permits", Ended: true}}
	done := &stateOverride{fakeStore: s, state: State{State: "taking", Tables: tables, Limits: s.limits}}
	deps := deps(s, d)
	deps.Store = done
	got, failure := Run(context.Background(), deps)
	if failure != nil || len(got) != 0 || d.reads != 0 {
		t.Fatalf("result %v, failure %v, reads %d", got, failure, d.reads)
	}
}

type stateOverride struct {
	*fakeStore
	state State
}

func (o *stateOverride) State(context.Context) (State, error) { return o.state, nil }

func TestAPullThatIsFinishingHasNothingToDo(t *testing.T) {
	s, d := newStore(), newDB()
	s.state = "finishing"
	got, failure := Run(context.Background(), deps(s, d))
	if failure != nil || len(got) != 0 || d.reads != 0 {
		t.Fatalf("result %v, failure %v", got, failure)
	}
}

func TestAPullWaitsForTheStoreToTakeIt(t *testing.T) {
	s, d := newStore(), newDB()
	s.waitsLeft = 3
	if _, failure := Run(context.Background(), deps(s, d)); failure != nil {
		t.Fatal(failure)
	}
	if s.rowsSent != 5 {
		t.Fatalf("sent %d", s.rowsSent)
	}
}

func TestATableWithNoKeyNamesRowsByHashAndRepeats(t *testing.T) {
	s, d := newStore(), newDB()
	d.key = nil
	d.rows = [][]*string{{ptr("X"), ptr("1")}, {ptr("X"), ptr("1")}, {ptr("Y"), nil}}
	if _, failure := Run(context.Background(), deps(s, d)); failure != nil {
		t.Fatal(failure)
	}
	h := RowHash([]*string{ptr("X"), ptr("1")})
	if _, ok := s.sent["h:"+h]; !ok {
		t.Fatalf("no row named by its hash: %v", s.sent)
	}
	if _, ok := s.sent["h:"+h+"#2"]; !ok {
		t.Fatalf("the repeat has no #2: %v", s.sent)
	}
	if len(s.sent) != 3 {
		t.Fatalf("sent %d", len(s.sent))
	}
}

func TestAKeyOfSeveralColumnsIsAJSONArray(t *testing.T) {
	values := []*string{ptr("2026"), ptr("x"), ptr("0412")}
	if got := KeyText(values, []int{0, 2}); got != `["2026","0412"]` {
		t.Fatalf("key %s", got)
	}
	if got := KeyText(values, []int{1}); got != "x" {
		t.Fatalf("key %s", got)
	}
}

func TestALongRowIsCutToItsLimitOnACharacterBoundary(t *testing.T) {
	long := strings.Repeat("é", 1000) // 2,000 bytes
	values := []*string{ptr("short"), &long}
	if cut := FitRow(values, 1005); cut != 1 {
		t.Fatalf("cut %d", cut)
	}
	if *values[0] != "short" {
		t.Fatalf("the short value changed: %q", *values[0])
	}
	if len(*values[1]) > 1000 || !strings.HasPrefix(*values[1], "é") || strings.ContainsRune(*values[1], '�') {
		t.Fatalf("cut to %d bytes", len(*values[1]))
	}
	if cut := FitRow([]*string{ptr("ab"), nil}, 20); cut != 0 {
		t.Fatalf("cut %d", cut)
	}
}

func TestARowIsCutByTheSizeOfItsJSON(t *testing.T) {
	// A NUL is six bytes in JSON: 700,000 of them are 4.2 MB, past what a page may be.
	nul := strings.Repeat("\x00", 700_000)
	values := []*string{ptr("short"), &nul}
	if cut := FitRow(values, 1_500_000); cut != 1 {
		t.Fatalf("cut %d", cut)
	}
	if size := len(mustJSON(values)); size > 1_500_000 || size < 1_400_000 {
		t.Fatalf("the row's JSON is %d bytes", size)
	}
	if *values[0] != "short" {
		t.Fatalf("the short value changed: %q", *values[0])
	}
}

func TestAPageOfRemovalsStaysWithinAPagesBytes(t *testing.T) {
	limits := Limits{PageBytes: 1_500_000, Removed: 20_000}
	long := strings.Repeat("k", 400)
	removed := make([]string, 20_000)
	for i := range removed {
		removed[i] = long
	}
	n := removedPage(removed, limits)
	if n < 3_000 || n > 3_800 {
		t.Fatalf("a page of %d keys of 400 bytes", n)
	}
	if size := len(mustJSON(removed[:n])); size > 1_500_000 {
		t.Fatalf("its JSON is %d bytes", size)
	}
	if n := removedPage([]string{"a", "b"}, limits); n != 2 {
		t.Fatalf("%d of two short keys", n)
	}
	if n := removedPage(removed, Limits{PageBytes: 100_000_000, Removed: 5}); n != 5 {
		t.Fatalf("%d, past a page's count", n)
	}
	if n := removedPage([]string{strings.Repeat("k", 2_000_000)}, limits); n != 1 {
		t.Fatalf("a key longer than a page must still go, alone: %d", n)
	}
}

func TestAHashIsTheSameAsTheWholeRowsCodeUnits(t *testing.T) {
	// A bad byte reads as one U+FFFD, and a character past U+FFFF as two code units, as in the store.
	for _, value := range []string{"plain", "é", "😀 emoji", "\xff\xfe", "a\xffb😀"} {
		if got, want := RowHash([]*string{&value}), refRowHash([]*string{&value}); got != want {
			t.Errorf("%q: %s, want %s", value, got, want)
		}
	}
}

// refRowHash is the hash spelled out over UTF-16 code units, as `rowHash` reads a string.
func refRowHash(values []*string) string {
	h1 := uint32(0xdeadbeef) ^ uint32(len(values))
	h2 := uint32(0x41c6ce57) ^ uint32(len(values))
	for _, v := range values {
		h1 = (h1 ^ hashValue) * 2654435761
		h2 = (h2 ^ hashValue) * 1597334677
		units := utf16.Encode([]rune(*v))
		for _, c := range units {
			h1 = (h1 ^ uint32(c)) * 2654435761
			h2 = (h2 ^ uint32(c)) * 1597334677
		}
		h1 = (h1 ^ uint32(len(units))) * 2654435761
		h2 = (h2 ^ uint32(len(units))) * 1597334677
	}
	h1 = (h1 ^ (h1 >> 16)) * 2246822507
	h1 ^= (h2 ^ (h2 >> 13)) * 3266489909
	h2 = (h2 ^ (h2 >> 16)) * 2246822507
	h2 ^= (h1 ^ (h1 >> 13)) * 3266489909
	return HashText(uint64(h2)<<32 | uint64(h1))
}

func TestARowsHashReadsItsValuesBeforeTheyAreCut(t *testing.T) {
	s, d := newStore(), newDB()
	s.limits.RowBytes = 40
	long := strings.Repeat("x", 100)
	d.rows = [][]*string{{ptr("A1"), &long}}
	if _, failure := Run(context.Background(), deps(s, d)); failure != nil {
		t.Fatal(failure)
	}
	row := s.sent["A1"]
	if *row[1] != RowHash([]*string{ptr("A1"), &long}) {
		t.Fatal("the hash was taken after the cut")
	}
	if len(*row[3]) >= 100 || s.ends[0].Cut != 1 {
		t.Fatalf("row %q, cut %d", *row[3], s.ends[0].Cut)
	}
}

func TestADatabaseErrorIsTheJobsFailure(t *testing.T) {
	s, d := newStore(), newDB()
	d.readErr = errors.New("permission denied")
	_, failure := Run(context.Background(), deps(s, d))
	if failure == nil || failure.Code != "database" {
		t.Fatalf("failure %+v", failure)
	}
}

func TestANewerDataJobTakesThePullOver(t *testing.T) {
	s, d := newStore(), newDB()
	s.refuseKey = true
	_, failure := Run(context.Background(), deps(s, d))
	if failure == nil || failure.Code != "store" || !strings.Contains(failure.Message, "newer data job") {
		t.Fatalf("failure %+v", failure)
	}
}

func TestAPageAtTheDaysWriteLimitSaysItInTheStoresWords(t *testing.T) {
	s, d := newStore(), newDB()
	s.pageErr = &StoreError{Status: 429, Code: "write_limit_reached", Message: "This store reached its limit of rows written today."}
	_, failure := Run(context.Background(), deps(s, d))
	if failure == nil || failure.Code != "store_limit" || failure.Message != "This store reached its limit of rows written today." {
		t.Fatalf("failure %+v", failure)
	}
}

func TestAPageCarriesEveryValueAsTextOrNull(t *testing.T) {
	body, err := pageJSON(0, 2, []byte(`["k","0123456789abcdef","v",null]`), []string{"gone"})
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"table":0,"page":2,"rows":[["k","0123456789abcdef","v",null]],"removed":["gone"]}` {
		t.Fatalf("%s", body)
	}
	empty, _ := pageJSON(1, 1, nil, nil)
	if string(empty) != `{"table":1,"page":1,"rows":[],"removed":[]}` {
		t.Fatalf("%s", empty)
	}
}

// The page wire's Go half: every fixture decodes into its type with no unknown field and encodes
// back the same. The gateway's side, in TypeScript, reads the same files.
func TestPageWireFixturesRoundTrip(t *testing.T) {
	for file, into := range map[string]any{
		"state.json":         &State{},
		"begin-body.json":    &BeginBody{},
		"begin-answer.json":  &BeginAnswer{},
		"hashes-body.json":   &HashesBody{},
		"hashes-answer.json": &HashesAnswer{},
		"page-answer.json":   &PageAnswer{},
		"end-body.json":      &EndBody{},
		"end-answer.json":    &EndAnswer{},
		"fail-body.json":     &FailBody{},
	} {
		t.Run(file, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("../../contract/pull", file))
			if err != nil {
				t.Fatal(err)
			}
			dec := json.NewDecoder(bytes.NewReader(data))
			dec.DisallowUnknownFields()
			if err := dec.Decode(into); err != nil {
				t.Fatalf("decode: %v", err)
			}
			again, err := json.Marshal(into)
			if err != nil {
				t.Fatal(err)
			}
			var want, got any
			_ = json.Unmarshal(data, &want)
			_ = json.Unmarshal(again, &got)
			if !reflect.DeepEqual(want, got) {
				t.Fatalf("round trip changed it:\nwant %v\ngot  %v", want, got)
			}
		})
	}
	data, err := os.ReadFile("../../contract/pull/page-body.json")
	if err != nil {
		t.Fatal(err)
	}
	var page struct {
		Table   int         `json:"table"`
		Page    int64       `json:"page"`
		Rows    [][]*string `json:"rows"`
		Removed []string    `json:"removed"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&page); err != nil {
		t.Fatal(err)
	}
	var rows []string
	for _, row := range page.Rows {
		encoded, _ := json.Marshal(row)
		rows = append(rows, string(encoded))
	}
	body, err := pageJSON(page.Table, page.Page, []byte(strings.Join(rows, ",")), page.Removed)
	if err != nil {
		t.Fatal(err)
	}
	var want, got any
	_ = json.Unmarshal(data, &want)
	_ = json.Unmarshal(body, &got)
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("page body:\nwant %v\ngot  %v", want, got)
	}
}
