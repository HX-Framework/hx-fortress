package run

// What every test of a job shares: a fake engine, a clock that moves only when a job sleeps, the
// stores a job that moves rows talks to, and a job straight to its server.

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"time"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/pull"
	"hx-fortress/data-runner/internal/push"
)

// noopDriver backs the *sql.DB a fake engine hands back; the fake's queries never reach it.
type noopDriver struct{}

func (noopDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("the fake engine opens no connection")
}

func init() { sql.Register("noop", noopDriver{}) }

// fakeEngine stands in for a driver: Open fails with openErr or hands back an unconnected *sql.DB,
// which the fake's queries never touch.
type fakeEngine struct {
	openErr  error
	queryErr error
	opened   *engine.Spec
	// failTimes, when set, fails only the first failTimes opens with openErr.
	failTimes int
	opens     int
}

func (f *fakeEngine) Open(_ context.Context, spec engine.Spec) (*sql.DB, error) {
	f.opened = &spec
	f.opens++
	if f.openErr != nil && (f.failTimes == 0 || f.opens <= f.failTimes) {
		return nil, f.openErr
	}
	return sql.Open("noop", "")
}
func (f *fakeEngine) Version(context.Context, engine.Querier) (string, error) {
	return "Fake 1.0", f.queryErr
}
func (f *fakeEngine) Writes(context.Context, engine.Querier, string) (engine.WriteSet, error) {
	return engine.WriteSet{Tables: map[string]bool{}, Powers: []string{}}, nil
}
func (f *fakeEngine) Catalog(_ context.Context, _ engine.Querier, database string, _ int, _ engine.WriteSet) (job.Catalog, error) {
	return job.Catalog{Engine: "postgres", Database: database, Tables: []job.Table{}}, nil
}
func (f *fakeEngine) Encryption(context.Context, engine.Querier, engine.Spec) job.Encryption {
	return job.Encryption{Kind: "tls", Version: job.Str("TLS 1.3"), Verified: true}
}
func (f *fakeEngine) Classify(err error) (string, string, bool) {
	if strings.Contains(err.Error(), "password authentication failed") {
		return "login", "The database refused the login.", true
	}
	return "", "", false
}

// fakeClock moves only when a job sleeps, so no test waits on the real clock.
type fakeClock struct{ at time.Time }

func (c *fakeClock) now() time.Time {
	if c.at.IsZero() {
		c.at = time.Now()
	}
	return c.at
}

func (c *fakeClock) sleep(ctx context.Context, d time.Duration) error {
	c.at = c.now().Add(d)
	return ctx.Err()
}

// pullWorld is a test's store for a pull: it hears a failure.
type pullStore struct {
	failed   *pull.FailBody
	state    pull.State
	calls    int
	stateErr error
}

func (s *pullStore) State(context.Context) (pull.State, error) { return s.state, s.stateErr }
func (s *pullStore) Begin(context.Context, pull.BeginBody) (pull.BeginAnswer, error) {
	return pull.BeginAnswer{Mode: "new"}, nil
}
func (s *pullStore) Hashes(context.Context, pull.HashesBody) (pull.HashesAnswer, error) {
	return pull.HashesAnswer{}, nil
}
func (s *pullStore) Page(context.Context, int, int64, []byte, []string) (pull.PageAnswer, error) {
	return pull.PageAnswer{Taken: true}, nil
}
func (s *pullStore) End(context.Context, pull.EndBody) (pull.EndAnswer, error) {
	return pull.EndAnswer{}, nil
}
func (s *pullStore) Fail(_ context.Context, body pull.FailBody) error {
	s.failed = &body
	s.calls++
	return nil
}

// rowsStore is a test's store for a push, a preview, a compare or an undo: it says where the job stands,
// and takes nothing else.
type rowsStore struct{ state push.State }

func (s *rowsStore) State(context.Context) (push.State, error) { return s.state, nil }
func (s *rowsStore) Begin(context.Context, push.BeginBody) (push.BeginAnswer, error) {
	return push.BeginAnswer{}, errors.New("this store takes no begin")
}
func (s *rowsStore) BeginAgain(context.Context) (push.BeginAnswer, error) {
	return push.BeginAnswer{}, errors.New("this store takes no begin")
}
func (s *rowsStore) Read(context.Context, push.ReadBody) (push.ReadAnswer, error) {
	return push.ReadAnswer{}, errors.New("this store holds no rows")
}
func (s *rowsStore) Send(context.Context, push.SendBody) (push.SendAnswer, error) {
	return push.SendAnswer{}, errors.New("this store takes no rows")
}
func (s *rowsStore) End(context.Context, push.EndBody) (push.EndAnswer, error) {
	return push.EndAnswer{}, errors.New("this store takes no end")
}
func (s *rowsStore) Fail(context.Context, pull.FailBody) error { return nil }

// fakes are a job's pieces for a test of a job straight to its server: a fake engine, the clock
// and the progress log. No way through a tunnel is among them.
type fakes struct {
	clock  fakeClock
	engine *fakeEngine
	log    bytes.Buffer
}

func (f *fakes) deps() Deps {
	return Deps{
		Engine:    func(string) (engine.Engine, error) { return f.engine, nil },
		Now:       f.clock.now,
		RetryWait: 3 * time.Second,
		Sleep:     f.clock.sleep,
		Log:       &f.log,
	}
}

// directJob is a job as a customer's HX Fortress hands it over: straight to the server.
func directJob() job.Job {
	return job.Job{
		V: 1, ID: "dj_1", Kind: "test", Engine: "sqlserver", Database: "Permits",
		Server:   job.HostPort{Host: "sql-01.example.internal", Port: 1433},
		TLS:      job.TLS{Mode: "verify", MinVersion: "1.2"},
		Reach:    job.Reach{Kind: "direct", Host: "sql-01.example.internal", Port: 1433},
		Login:    job.Login{Kind: "read", User: "reader", Password: "the-password"},
		Deadline: time.Now().Add(time.Minute).Format(time.RFC3339Nano),
	}
}

// directPullJob is a pull straight to its server, for a store job.
func directPullJob() job.Job {
	j := directJob()
	j.Kind = "pull"
	j.Store = &job.Store{GatewayURL: "https://gw.example", StoreID: "sto_1", JobID: "job_1", Key: "k1.the-store-key"}
	return j
}
