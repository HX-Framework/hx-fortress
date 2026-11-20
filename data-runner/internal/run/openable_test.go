package run

// A query whose rows name databases, with params.onlyOpenable: the job opens each database the
// way it opened its own, and answers only the ones the server let its login open. A database whose
// open failed for another reason stays.

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
)

// listingPostgres is Postgres's engine on a script. The job's own database answers the listing;
// each other database opens, or fails with the error opens holds for it. Its judgment of an error
// is Postgres's own.
type listingPostgres struct {
	engine.Postgres
	script string
	own    string
	opens  map[string]error

	mu     *sync.Mutex
	probes *[]engine.Spec
}

func (p listingPostgres) Open(_ context.Context, spec engine.Spec) (*sql.DB, error) {
	if spec.Job.Database == p.own {
		return sql.Open("script", p.script)
	}
	p.mu.Lock()
	*p.probes = append(*p.probes, spec)
	p.mu.Unlock()
	if err := p.opens[spec.Job.Database]; err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	return sql.Open("noop", "")
}

// listed is what a listing query on a script answered, and the databases it opened besides its own.
type listed struct {
	out    job.Output
	probes []engine.Spec
	log    string
}

// runListing runs a query on Postgres's database "postgres" whose statement reads rows, each a
// database, with the params given.
func runListing(t *testing.T, rows []string, opens map[string]error, params map[string]any) listed {
	t.Helper()
	scriptsMu.Lock()
	scripts[t.Name()] = &script{rows: rows}
	scriptsMu.Unlock()
	var probes []engine.Spec
	eng := listingPostgres{script: t.Name(), own: "postgres", opens: opens, mu: &sync.Mutex{}, probes: &probes}
	f := &fakes{engine: &fakeEngine{}}
	d := f.deps()
	d.Engine = func(string) (engine.Engine, error) { return eng, nil }
	j := directJob()
	j.Kind, j.Engine, j.Database = "query", "postgres", "postgres"
	j.Server = job.HostPort{Host: "pg.northstar.example", Port: 5432}
	j.Reach = job.Reach{Kind: "direct", Host: "pg.northstar.example", Port: 5432}
	j.Login = job.Login{Kind: "read", User: "permits_reader", Password: "example-password"}
	j.Params = params
	out := Run(context.Background(), j, d)
	return listed{out: out, probes: probes, log: f.log.String()}
}

const listingSQL = "SELECT datname FROM pg_database ORDER BY datname"

// databasesOf is the first value of each row of a query's answer.
func databasesOf(t *testing.T, out job.Output) []string {
	t.Helper()
	if !out.OK {
		t.Fatalf("the query failed: %+v", out.Error)
	}
	result, ok := out.Result.(*job.QueryResult)
	if !ok {
		t.Fatalf("the answer is no query's: %#v", out.Result)
	}
	names := []string{}
	for _, row := range result.Rows {
		names = append(names, *row[0])
	}
	return names
}

func TestAListOfDatabasesKeepsTheOnesTheLoginOpens(t *testing.T) {
	got := runListing(t, []string{"archive", "permits", "postgres", "reports", "town"}, map[string]error{
		// A rule of the server's access file refused this login on it: out.
		"archive": &pgconn.PgError{Code: "28000", Message: `pg_hba.conf rejects connection for host "192.0.2.10", user "permits_reader", database "archive", SSL encryption`},
		// The server was full for a moment: that says nothing about the database, so it stays.
		"reports": &pgconn.PgError{Code: "53300", Message: "sorry, too many clients already"},
		// Dropped between the listing and its open: out.
		"town": &pgconn.PgError{Code: "3D000", Message: `database "town" does not exist`},
	}, map[string]any{"sql": listingSQL, "limit": float64(200), "onlyOpenable": true})

	if names := databasesOf(t, got.out); !slices.Equal(names, []string{"permits", "postgres", "reports"}) {
		t.Fatalf("answered %v", names)
	}
	opened := []string{}
	for _, probe := range got.probes {
		opened = append(opened, probe.Job.Database)
		// Each database is opened the way the job opened its own: the same server and the same
		// way to it, TLS and login, through a Dialer of its own.
		if probe.Job.Server != (job.HostPort{Host: "pg.northstar.example", Port: 5432}) || probe.Job.Login.User != "permits_reader" ||
			probe.Job.TLS.Mode != "verify" || probe.Dialer == nil || probe.Dialer.Server != "pg.northstar.example:5432" || probe.Capture == nil {
			t.Fatalf("%s was opened another way: %+v", probe.Job.Database, probe)
		}
	}
	slices.Sort(opened)
	// The job's own database was open already, and is not opened again.
	if !slices.Equal(opened, []string{"archive", "permits", "reports", "town"}) {
		t.Fatalf("opened %v", opened)
	}
	if !strings.Contains(got.log, "left out 2 of 5 databases") {
		t.Fatalf("the log does not say what was left out:\n%s", got.log)
	}
	if strings.Contains(got.log, "example-password") {
		t.Fatal("the log holds the password")
	}
}

func TestAListWithoutOnlyOpenableOpensNothingMore(t *testing.T) {
	got := runListing(t, []string{"archive", "permits", "postgres"}, map[string]error{
		"archive": &pgconn.PgError{Code: "28000", Message: "pg_hba.conf rejects connection"},
	}, map[string]any{"sql": listingSQL, "limit": float64(200)})

	if names := databasesOf(t, got.out); !slices.Equal(names, []string{"archive", "permits", "postgres"}) {
		t.Fatalf("answered %v", names)
	}
	if len(got.probes) != 0 {
		t.Fatalf("opened %d databases besides its own", len(got.probes))
	}
}
