package run

// A job straight to its server: the one way a build without the hosted runner's files has, and
// the way a customer's HX Fortress uses.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/pull"
	"hx-fortress/data-runner/internal/push"
	"hx-fortress/data-runner/internal/reach"
	"hx-fortress/data-runner/internal/secure"
)

// A job straight to its server dials the host and port it names, and its output says where it ran
// as null: it asked nobody.
func TestAJobStraightToItsServerDialsTheAddressItNames(t *testing.T) {
	f := &fakes{engine: &fakeEngine{}}
	out := Run(context.Background(), directJob(), f.deps())
	if !out.OK || out.Error != nil || out.Where != nil {
		t.Fatalf("output %+v", out)
	}
	dialer := f.engine.opened.Dialer
	if dialer.Server != "sql-01.example.internal:1433" || dialer.Target != "sql-01.example.internal:1433" {
		t.Fatalf("the driver dials %s at %s", dialer.Server, dialer.Target)
	}
	if said := f.log.String(); strings.Contains(said, "where:") || strings.Contains(said, "tunnel") || strings.Contains(said, "the-password") {
		t.Fatalf("progress lines: %s", said)
	}
}

// Every kind runs with no way through a tunnel among its pieces, however the job ends.
func TestEveryKindRunsStraightToItsServer(t *testing.T) {
	store := &job.Store{GatewayURL: "http://127.0.0.1:9", StoreID: "sto_1", JobID: "job_1", Key: "k1.the-store-key"}
	for _, kind := range job.Kinds {
		f := &fakes{engine: &fakeEngine{}}
		d := f.deps()
		d.NewStore = func(job.Store, func(context.Context, time.Duration) error) pull.Store {
			return &pullStore{state: pull.State{State: "failed"}}
		}
		d.NewRowsStore = func(job.Store, func(context.Context, time.Duration) error) push.Store {
			return &rowsStore{state: push.State{Kind: kind, State: "done"}}
		}
		j := directJob()
		j.Kind = kind
		if kind == "query" {
			j.Params = map[string]any{"sql": "SELECT 1"}
		} else if kind != "test" {
			j.Store = store
		}
		if out := Run(context.Background(), j, d); out.Where != nil || f.engine.opened == nil {
			t.Errorf("%s: output %+v, opened %v", kind, out, f.engine.opened)
		}
	}
}

// A runner with no way through a tunnel among its pieces, as the build an HX Fortress starts has
// none, refuses a job through a tunnel before it opens anything.
func TestARunnerWithNoWayThroughAccessTakesNoSuchJob(t *testing.T) {
	j := directJob()
	j.Reach = job.Reach{Kind: "access", Hostname: "db-1.example.net", ClientID: "id", ClientSecret: "the-client-secret"}
	f := &fakes{engine: &fakeEngine{}}
	out := Run(context.Background(), j, f.deps())
	if out.OK || out.Error.Code != "not_ready" || !strings.Contains(out.Error.Message, "takes no job through a tunnel") || f.engine.opened != nil {
		t.Fatalf("output %+v, opened %v", out, f.engine.opened)
	}
}

// A runner with no way to an address on the internet, as the build an HX Fortress starts has none,
// refuses a job whose reach is public before it opens anything: only a hosted runner checks where it
// runs and which addresses its driver dials.
func TestARunnerWithNoPublicWayTakesNoSuchJob(t *testing.T) {
	j := directJob()
	j.Reach.Kind = "public"
	j.Country = "US"
	f := &fakes{engine: &fakeEngine{}}
	out := Run(context.Background(), j, f.deps())
	if out.OK || out.Error.Code != "not_ready" || !strings.Contains(out.Error.Message, "no job whose reach is public") || f.engine.opened != nil || out.Where != nil {
		t.Fatalf("output %+v, opened %v", out, f.engine.opened)
	}
}

// Only a job from a hosted container can check where it runs, so a job straight to its server
// that names a country is refused before it opens anything. job.Validate refuses the pair when a
// job is read; this holds for a job that never went through it.
func TestAJobStraightToItsServerNamesNoCountry(t *testing.T) {
	j := directJob()
	j.Country = "US"
	f := &fakes{engine: &fakeEngine{}}
	out := Run(context.Background(), j, f.deps())
	if out.OK || out.Error.Code != "internal" || !strings.Contains(out.Error.Message, "names no country") || f.engine.opened != nil {
		t.Fatalf("output %+v, opened %v", out, f.engine.opened)
	}
}

// A failed connect is the answer: nothing is tried again, since no path was still opening.
func TestAFailedConnectStraightToTheServerIsTheAnswer(t *testing.T) {
	f := &fakes{engine: &fakeEngine{openErr: errors.New("read tcp 192.0.2.5:1433: EOF")}}
	start := f.clock.now()
	out := Run(context.Background(), directJob(), f.deps())
	if out.OK || out.Error.Code != "unreachable" || f.engine.opens != 1 || f.clock.now() != start {
		t.Fatalf("output %+v after %d opens over %s", out.Error, f.engine.opens, f.clock.now().Sub(start))
	}
}

// A server that sends its login on to another address is refused: a job opens no connection but
// the one its connection names. The words name no tunnel, and the advice is the engine's own.
func TestARedirectStraightFromTheServerIsRefusedInItsOwnWords(t *testing.T) {
	redirect := &reach.RedirectError{Addr: "worker-7.example.net:11000"}
	for engineName, advice := range map[string]string{
		"sqlserver": "For Azure SQL, set the server's connection policy to Proxy.",
		"oracle":    "For Oracle, name a database node's own listener",
		"postgres":  "",
	} {
		// Wrapped, and flattened into a driver's own text: both are a redirect.
		for _, err := range []error{fmt.Errorf("login: %w", redirect), fmt.Errorf("login: %v", redirect)} {
			f := &fakes{engine: &fakeEngine{openErr: err}}
			j := directJob()
			j.Engine = engineName
			out := Run(context.Background(), j, f.deps())
			if out.OK || out.Error.Code != "unreachable" || f.engine.opens != 1 {
				t.Fatalf("%s, %v: output %+v after %d opens", engineName, err, out.Error, f.engine.opens)
			}
			m := out.Error.Message
			if !strings.Contains(m, "sent the connection on to worker-7.example.net:11000.") || strings.Contains(m, "tunnel") || !strings.Contains(m, advice) {
				t.Fatalf("%s: message %q", engineName, m)
			}
			if advice == "" && !strings.HasSuffix(m, "the server its connection names.") {
				t.Fatalf("%s: advice for another engine: %q", engineName, m)
			}
		}
	}
	// A redirect that shows up in a query, on a connection the pool opened again, reads the same.
	f := &fakes{engine: &fakeEngine{}}
	r := &runner{j: directJob(), d: f.deps(), start: f.clock.now()}
	if failure := r.queryFailure(context.Background(), f.engine, fmt.Errorf("read: %w", redirect), "read the catalog"); failure.Code != "unreachable" ||
		!strings.HasPrefix(failure.Message, "Could not read the catalog. The server sent the connection on to worker-7.example.net:11000.") || strings.Contains(failure.Message, "tunnel") {
		t.Fatalf("in a query: %+v", failure)
	}
}

// The job's own context reaches the Dialer, so a login that waits on a silent server ends with the
// job (the Dialer's own test shows the connection closing).
func TestTheDialerStopsALoginWhenTheJobEnds(t *testing.T) {
	f := &fakes{engine: &fakeEngine{}}
	if out := Run(context.Background(), directJob(), f.deps()); !out.OK {
		t.Fatalf("output %+v", out)
	}
	until := f.engine.opened.Dialer.Until
	if until == nil || until.Err() == nil {
		t.Fatal("the Dialer was not given the job's context, which ends when the job does")
	}
}

// The database sees the session under the name its caller gave the runner's pieces.
func TestTheSessionCarriesTheNameItsCallerGave(t *testing.T) {
	f := &fakes{engine: &fakeEngine{}}
	d := f.deps()
	d.AppName = "a caller's own name"
	if out := Run(context.Background(), directJob(), d); !out.OK || f.engine.opened.AppName != "a caller's own name" {
		t.Fatalf("output %+v, app name %q", out, f.engine.opened.AppName)
	}
}

// ─── what a job does whichever way it reaches its server ───────────────────

func TestAFailedQueryIsNamed(t *testing.T) {
	f := &fakes{engine: &fakeEngine{queryErr: errors.New("permission denied for function version")}}
	j := directJob()
	j.Reach = job.Reach{Kind: "direct", Host: "127.0.0.1", Port: 5432}
	out := Run(context.Background(), j, f.deps())
	if out.OK || out.Error.Code != "database" || !strings.Contains(out.Error.Message, "version") {
		t.Fatalf("output %+v", out.Error)
	}
	if f.engine.opened.Dialer.Target != "127.0.0.1:5432" {
		t.Fatalf("direct reach dialed %s", f.engine.opened.Dialer.Target)
	}
}

func TestAJobStoppedWhileItConnectsOrQueriesIsAtItsDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	j := directJob()
	f := &fakes{engine: &fakeEngine{openErr: context.Canceled}}
	r := &runner{j: j, d: f.deps(), start: f.clock.now()}
	if failure, again := r.connectFailure(ctx, f.engine, context.Canceled, nil, nil); failure.Code != "deadline" || again != retryNone {
		t.Fatalf("connect: %+v %v", failure, again)
	}
	if failure := r.queryFailure(ctx, f.engine, errors.New("context canceled"), "read the catalog"); failure.Code != "deadline" {
		t.Fatalf("query: %+v", failure)
	}
}

func TestAConnectThatTimesOutIsNotTheJobsDeadline(t *testing.T) {
	f := &fakes{engine: &fakeEngine{openErr: fmt.Errorf("dial: %w", context.DeadlineExceeded)}}
	out := Run(context.Background(), directJob(), f.deps())
	if out.OK || out.Error.Code != "unreachable" || !strings.Contains(out.Error.Message, "30 seconds") {
		t.Fatalf("output %+v", out.Error)
	}
}

func TestACatalogTooBigForTheOutputIsCut(t *testing.T) {
	c := job.Catalog{Engine: "postgres", Database: "permits"}
	for i := 0; i < 50; i++ {
		c.Tables = append(c.Tables, job.Table{Schema: "public", Name: fmt.Sprintf("t%02d", i), Kind: "table", Columns: []job.Column{{Name: strings.Repeat("c", 100), Type: "text"}}})
	}
	one, _ := json.Marshal(c.Tables[0])
	FitCatalog(&c, 10*(len(one)+1))
	if len(c.Tables) != 10 || !c.Truncated {
		t.Fatalf("kept %d tables, truncated %t", len(c.Tables), c.Truncated)
	}
	small := job.Catalog{Tables: c.Tables[:2]}
	FitCatalog(&small, CatalogBudget)
	if len(small.Tables) != 2 || small.Truncated {
		t.Fatalf("a small catalog was cut: %+v", small)
	}
}

func TestAPullAtTheWriteLimitTellsTheStore(t *testing.T) {
	store := &pullStore{stateErr: &pull.StoreError{Status: 429, Code: "write_limit_reached", Message: "This store reached its limit."}}
	f := &fakes{engine: &fakeEngine{}}
	d := f.deps()
	d.NewStore = func(job.Store, func(context.Context, time.Duration) error) pull.Store { return store }
	out := Run(context.Background(), directPullJob(), d)
	if out.OK || out.Error.Code != "store_limit" {
		t.Fatalf("output %+v", out)
	}
	if store.failed == nil || store.failed.Code != "store_limit" || store.calls != 1 {
		t.Fatalf("the store heard %+v (%d calls)", store.failed, store.calls)
	}
}

func TestAPullPastItsDeadlineLeavesTheJobOpen(t *testing.T) {
	store := &pullStore{}
	f := &fakes{engine: &fakeEngine{}}
	d := f.deps()
	d.NewStore = func(job.Store, func(context.Context, time.Duration) error) pull.Store { return store }
	j := directPullJob()
	j.Deadline = time.Now().Add(-time.Second).Format(time.RFC3339Nano)
	out := Run(context.Background(), j, d)
	if out.OK || out.Error.Code != "deadline" || store.failed != nil {
		t.Fatalf("output %+v, the store heard %+v", out, store.failed)
	}
}

func TestAStoresKeyNeverReachesTheLog(t *testing.T) {
	store := &pullStore{state: pull.State{State: "failed"}}
	f := &fakes{engine: &fakeEngine{}}
	d := f.deps()
	d.NewStore = func(job.Store, func(context.Context, time.Duration) error) pull.Store { return store }
	_ = Run(context.Background(), directPullJob(), d)
	if strings.Contains(f.log.String(), "k1.the-store-key") {
		t.Fatal("the key reached the progress log")
	}
}

// A data job of kind push, with the write login, does a write and an undo; one of kind compare, with
// the read login, does a preview and a compare. Neither does the other's.
func TestEachDataJobKindRunsItsOwnStoreJobs(t *testing.T) {
	for _, c := range []struct {
		data, store string
		ok          bool
	}{
		{"push", "push", true}, {"push", "push_undo", true}, {"push", "push_preview", false}, {"push", "compare", false},
		{"compare", "push_preview", true}, {"compare", "compare", true}, {"compare", "push", false}, {"compare", "push_undo", false},
	} {
		// The store's job is done: an earlier data job did the runner's part, so this one reads nothing.
		store := &rowsStore{state: push.State{Kind: c.store, State: "done"}}
		f := &fakes{engine: &fakeEngine{}}
		d := f.deps()
		d.NewRowsStore = func(job.Store, func(context.Context, time.Duration) error) push.Store { return store }
		j := directPullJob()
		j.Kind = c.data
		out := Run(context.Background(), j, d)
		if out.OK != c.ok || (c.ok && out.Result.ResultKind() != c.data) || (!c.ok && out.Error.Code != "store") {
			t.Errorf("a %s data job on a %s: %+v", c.data, c.store, out)
		}
	}
}

// A refused login is the answer, and a job's own secrets never reach its output: its password and
// its store's key, as they are and as a URL would carry them.
func TestARefusedLoginIsTheAnswerAndSecretsAreScrubbed(t *testing.T) {
	f := &fakes{engine: &fakeEngine{openErr: errors.New("password authentication failed for the-password")}}
	out := Run(context.Background(), directJob(), f.deps())
	if out.OK || out.Error.Code != "login" || f.engine.opens != 1 {
		t.Fatalf("output %+v after %d opens", out.Error, f.engine.opens)
	}
	j := directPullJob()
	j.Login.Password = "p@ss/w0rd#1 x"
	for _, form := range []string{j.Login.Password, url.PathEscape(j.Login.Password), url.QueryEscape(j.Login.Password), url.UserPassword("scott", j.Login.Password).String(), j.Store.Key} {
		f := &fakes{engine: &fakeEngine{openErr: fmt.Errorf("password authentication failed: parse %q", form)}}
		out := Run(context.Background(), j, f.deps())
		if strings.Contains(out.Error.Message, "w0rd") || strings.Contains(out.Error.Message, "the-store-key") {
			t.Fatalf("a secret reached the output: %q", out.Error.Message)
		}
	}
}

// A kind this runner does not run, a job that moves rows with no store job, and a deadline that has
// passed each end before anything opens.
func TestAJobThatCannotRunOpensNothing(t *testing.T) {
	for name, c := range map[string]struct {
		change func(j *job.Job)
		code   string
	}{
		"a kind not built":        {func(j *job.Job) { j.Kind = "export" }, "not_ready"},
		"a push with no store":    {func(j *job.Job) { j.Kind = "push" }, "internal"},
		"a compare with no store": {func(j *job.Job) { j.Kind = "compare" }, "internal"},
		"a deadline that passed":  {func(j *job.Job) { j.Deadline = time.Now().Add(-time.Second).Format(time.RFC3339Nano) }, "deadline"},
	} {
		j := directJob()
		c.change(&j)
		f := &fakes{engine: &fakeEngine{}}
		if out := Run(context.Background(), j, f.deps()); out.OK || out.Error.Code != c.code || f.engine.opened != nil {
			t.Errorf("%s: output %+v, opened %v", name, out, f.engine.opened)
		}
	}
}

// A certificate the job's settings refused fails the job as `tls`, in the refusal's own words,
// whatever a driver made of the handshake's error.
func TestARefusedCertificateIsTheAnswerInItsOwnWords(t *testing.T) {
	f := &fakes{engine: &fakeEngine{}}
	r := &runner{j: directJob(), d: f.deps(), start: f.clock.now()}
	words := "The server's certificate names sql-02.example.internal, but this connection expects sql-01.example.internal."
	failure, again := r.connectFailure(context.Background(), f.engine, fmt.Errorf("tls error: %w", &secure.Refusal{Words: words}), nil, nil)
	if failure.Code != "tls" || failure.Message != words || again != retryNone {
		t.Fatalf("connect: %+v %v", failure, again)
	}
}
