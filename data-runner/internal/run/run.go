// Package run does one data job: it opens the way to the database, connects with the engine's
// driver, does the job's kind, and answers one output. It never returns an error: every failure
// becomes the output's error, with a code and one plain sentence.
//
// A job straight to its server (reach `direct`) opens connections to the host and port it names
// and, when it moves rows, to its store's gateway, and to nothing else. A job through a hostname
// behind Cloudflare Access (reach `access`) first checks where it runs and starts a tunnel client:
// that way is access.go, which a build with the tag `direct` leaves out. Such a build takes only
// jobs straight to their server.
package run

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/pull"
	"hx-fortress/data-runner/internal/push"
	"hx-fortress/data-runner/internal/reach"
	"hx-fortress/data-runner/internal/secure"
)

// DefaultCatalogMax is how many tables a catalog keeps when the job names no number.
const DefaultCatalogMax = 5000

// CatalogBudget is the most bytes of JSON a test's catalog may take in the output. The sandbox
// answers at most 8 MiB of a command's stdout, and an output cut there cannot be read at all; the
// rest of the output needs a little room too.
const CatalogBudget = 6 << 20

// Deps are the pieces a job uses, so tests can replace each.
type Deps struct {
	// Access is the way through a hostname behind Cloudflare Access (AccessDeps), in a build that
	// has it. Nil in a build without it, which takes only a job straight to its server.
	Access accessWay
	Engine func(name string) (engine.Engine, error)
	Now    func() time.Time
	// RetryWait is the pause between connects while the way to the database is not ready.
	RetryWait time.Duration
	// Sleep waits d, or until ctx ends (tests pass a fake clock's).
	Sleep func(ctx context.Context, d time.Duration) error
	// Log takes progress lines. They name no login, token or row.
	Log io.Writer
	// Stages takes one stage line as the job starts each step its page shows while it runs (the
	// tunnel, each connect, reading a test's tables): StagePrefix and a JSON object with the step's
	// name and, for a connect, its try. A line names no login, token or row. Nil writes none.
	Stages io.Writer
	// AppName is the application name the database sees for the job's session. Empty is
	// DefaultAppName.
	AppName string
	// NewStore is the store's side of a pull, for the job's store and key.
	NewStore func(store job.Store, sleep func(ctx context.Context, d time.Duration) error) pull.Store
	// NewRowsStore is the store's side of a push, a preview or a compare.
	NewRowsStore func(store job.Store, sleep func(ctx context.Context, d time.Duration) error) push.Store
}

// accessWay is what a job through Cloudflare Access does that a job straight to its server does
// not. Its one kind is *AccessDeps, in access.go.
type accessWay interface {
	// enter says where the runner is before anything opens, and holds a job that names a country
	// to it.
	enter(ctx context.Context, r *runner) *job.Error
	// open starts the way to the job's hostname.
	open(ctx context.Context, r *runner) (accessPath, *job.Error)
}

// accessPath is an open way through Access.
type accessPath interface {
	// target is the local address the driver's one connection goes to.
	target() string
	// explain reads a connect that failed through the path: why, and what may be tried next.
	explain(ctx context.Context, r *runner, code, message string) (*job.Error, retry)
	close()
}

// Production is the runner's real pieces for a job straight to its server: the drivers and the
// store's gateway. A build with the way through Access adds it (ProductionAccess).
func Production(log io.Writer) Deps {
	return Deps{
		Engine:    engine.For,
		Now:       time.Now,
		RetryWait: 3 * time.Second,
		Sleep:     sleep,
		Log:       log,
		NewStore: func(store job.Store, sleep func(ctx context.Context, d time.Duration) error) pull.Store {
			return pull.NewHTTPStore(store.GatewayURL, store.StoreID, store.JobID, store.Key, sleep)
		},
		NewRowsStore: func(store job.Store, sleep func(ctx context.Context, d time.Duration) error) push.Store {
			return push.NewHTTPStore(store.GatewayURL, store.StoreID, store.JobID, store.Key, sleep)
		},
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Run does the job.
func Run(ctx context.Context, j job.Job, d Deps) job.Output {
	r := &runner{j: j, d: d, start: d.Now()}
	return r.run(ctx)
}

type runner struct {
	j     job.Job
	d     Deps
	start time.Time
	where *job.Where
}

func (r *runner) logf(format string, args ...any) {
	if r.d.Log != nil {
		fmt.Fprintf(r.d.Log, "data-runner: "+format+"\n", args...)
	}
}

// StagePrefix starts every stage line; the rest of the line is one JSON object, which the runner's
// caller reads while the job runs.
const StagePrefix = "data-runner stage "

// The steps a job tells as it starts them, in the order it reaches them.
const (
	StageTunnel  = "tunnel"
	StageConnect = "connect"
	StageCatalog = "catalog"
)

type stageLine struct {
	Stage string `json:"stage"`
	Try   int    `json:"try,omitempty"`
}

// stage tells the api the job started a step, in one write, so a reader never sees half a line.
// try is the connect under way, from 1, and 0 for any other step.
func (r *runner) stage(name string, try int) {
	if r.d.Stages == nil {
		return
	}
	b, err := json.Marshal(stageLine{Stage: name, Try: try})
	if err != nil {
		return
	}
	_, _ = r.d.Stages.Write([]byte(StagePrefix + string(b) + "\n"))
}

func (r *runner) since(t time.Time) int64 { return r.d.Now().Sub(t).Milliseconds() }

func (r *runner) output(result job.Result, failure *job.Error) job.Output {
	out := job.Output{V: 1, ID: r.j.ID, Where: r.where, MS: r.since(r.start)}
	if failure != nil {
		failure.Message = r.scrub(failure.Message)
		out.Error = failure
		r.logf("failed: %s", failure.Code)
		return out
	}
	out.OK = true
	out.Result = result
	return out
}

// scrub takes the job's own secrets out of a message, in case a driver ever repeats one: as they
// are, and as a URL would carry them (a driver that builds a URL from the login may quote it).
func (r *runner) scrub(message string) string {
	secrets := []string{r.j.Login.Password, r.j.Reach.ClientSecret}
	if r.j.Store != nil {
		secrets = append(secrets, r.j.Store.Key)
	}
	for _, secret := range secrets {
		if len(secret) < 4 {
			continue
		}
		userinfo := strings.TrimPrefix(url.UserPassword("u", secret).String(), "u:")
		for _, form := range []string{secret, url.QueryEscape(secret), url.PathEscape(secret), userinfo} {
			message = strings.ReplaceAll(message, form, "••••")
		}
	}
	return message
}

func (r *runner) run(parent context.Context) (out job.Output) {
	defer func() { r.tellStore(parent, out) }()
	ctx, cancel := context.WithDeadline(parent, r.j.DeadlineTime())
	defer cancel()
	if ctx.Err() != nil {
		return r.output(nil, job.Fail("deadline", "The job's deadline had passed before it started."))
	}

	// 1. A job through Access checks where its container is before anything opens, in a build that
	// has that way. A job straight to its server asks nobody, so its output's `where` is null, and
	// it names no country: nothing here could check one (job.Validate refuses the pair, and so does
	// this, for a job that was never validated).
	if r.j.Reach.Kind == "access" {
		if r.d.Access == nil {
			return r.output(nil, job.Fail("not_ready", "This runner reaches a database straight at its address only: it takes no job through Cloudflare Access."))
		}
		if failure := r.d.Access.enter(ctx, r); failure != nil {
			return r.output(nil, failure)
		}
	} else if r.j.Country != "" {
		return r.output(nil, job.Fail("internal", "A job straight to its server names no country: only a job through Access can check where it runs."))
	}
	switch r.j.Kind {
	case "test", "pull", "query", "push", "compare":
	default:
		return r.output(nil, job.Fail("not_ready", "This runner does not run %s jobs.", r.j.Kind))
	}
	if (r.j.Kind == "pull" || r.j.Kind == "push" || r.j.Kind == "compare") && r.j.Store == nil {
		return r.output(nil, job.Fail("internal", "A %s job names the store job it works for, and this one names none.", r.j.Kind))
	}

	eng, err := r.d.Engine(r.j.Engine)
	if err != nil {
		return r.output(nil, job.Fail("internal", "%s", err))
	}

	// 2. The way to the database.
	tunnelStart := r.d.Now()
	target := reach.ServerAddr(r.j.Reach.Host, r.j.Reach.Port)
	var path accessPath
	if r.j.Reach.Kind == "access" {
		r.stage(StageTunnel, 0)
		var failure *job.Error
		if path, failure = r.d.Access.open(ctx, r); failure != nil {
			return r.output(nil, failure)
		}
		defer path.close()
		target = path.target()
	}
	tunnelMS := r.since(tunnelStart)

	// 3. Connect.
	capture := &secure.Capture{}
	spec := engine.Spec{
		Job:     r.j,
		Dialer:  &reach.Dialer{Server: reach.ServerAddr(r.j.Server.Host, r.j.Server.Port), Target: target, LoginFor: engine.ConnectTimeout, Until: ctx},
		Capture: capture,
		AppName: r.d.AppName,
	}
	connectStart := r.d.Now()
	var db *sql.DB
	raced := false
	for attempt := 1; ; attempt++ {
		var err error
		r.stage(StageConnect, attempt)
		db, err = eng.Open(ctx, spec)
		if err == nil {
			break
		}
		failure, retry := r.connectFailure(ctx, eng, err, path, capture)
		// Only a way through Access asks for another try: a connect that raced the path gets one more
		// at once, and while the hostname is not served yet, connects go on for ConnectRetryFor.
		if retry == retryRaced {
			if raced {
				retry = retryNone
			}
			raced = true
		}
		if retry == retryNone || r.d.Now().Sub(connectStart)+r.d.RetryWait > ConnectRetryFor || ctx.Err() != nil {
			return r.output(nil, failure)
		}
		wait := r.d.RetryWait
		if retry == retryRaced {
			wait = 0
		}
		r.logf("connect %d: the path to the database was not ready; trying again", attempt)
		if err := r.d.Sleep(ctx, wait); err != nil {
			return r.output(nil, job.Fail("deadline", "The job reached its deadline while the way to its database was not ready."))
		}
	}
	defer db.Close()
	spec.Dialer.Settled()
	connectMS := r.since(connectStart)
	encryption := eng.Encryption(ctx, db, spec)
	r.logf("connected in %d ms, encryption %s %s", connectMS, encryption.Kind, deref(encryption.Version))

	// 4. The job.
	switch r.j.Kind {
	case "pull":
		result, failure := r.pull(ctx, eng, db)
		if failure != nil {
			return r.output(nil, failure)
		}
		result.MS = job.PullMS{Tunnel: tunnelMS, Connect: connectMS, Total: r.since(r.start)}
		return r.output(result, nil)
	case "query":
		result, failure := r.query(ctx, eng, db)
		if failure != nil {
			return r.output(nil, failure)
		}
		result.MS.Tunnel = tunnelMS
		result.MS.Connect = connectMS
		result.MS.Total = r.since(r.start)
		return r.output(result, nil)
	case "push", "compare":
		result, failure := r.push(ctx, eng, db, job.PullMS{Tunnel: tunnelMS, Connect: connectMS})
		if failure != nil {
			return r.output(nil, failure)
		}
		return r.output(result, nil)
	}
	result, failure := r.test(ctx, eng, db, encryption)
	if failure != nil {
		return r.output(nil, failure)
	}
	result.MS.Tunnel = tunnelMS
	result.MS.Connect = connectMS
	result.MS.Total = r.since(r.start)
	return r.output(result, nil)
}

func (r *runner) test(ctx context.Context, eng engine.Engine, db *sql.DB, encryption job.Encryption) (*job.TestResult, *job.Error) {
	r.stage(StageCatalog, 0)
	catalogStart := r.d.Now()
	version, err := eng.Version(ctx, db)
	if err != nil {
		return nil, r.queryFailure(ctx, eng, err, "read the server's version")
	}
	writes, err := eng.Writes(ctx, db, r.j.Database)
	if err != nil {
		return nil, r.queryFailure(ctx, eng, err, "check what the login may change")
	}
	max := r.j.CatalogMaxTables
	if max <= 0 {
		max = DefaultCatalogMax
	}
	catalog, err := eng.Catalog(ctx, db, r.j.Database, max, writes)
	if err != nil {
		return nil, r.queryFailure(ctx, eng, err, "read the catalog")
	}
	FitCatalog(&catalog, CatalogBudget)
	check := engine.WriteCheck(writes, 20)
	r.logf("catalog: %d tables in %d ms; login can write: %t", len(catalog.Tables), r.since(catalogStart), check.CanWrite)
	return &job.TestResult{
		Kind:          "test",
		Login:         r.j.Login.Kind,
		ServerVersion: version,
		Encryption:    encryption,
		Write:         check,
		Catalog:       catalog,
		MS:            job.TestMS{Catalog: r.since(catalogStart)},
	}, nil
}

// FitCatalog keeps the catalog's first tables whose JSON fits in budget bytes, and marks it
// truncated when it drops any.
func FitCatalog(c *job.Catalog, budget int) {
	used := 0
	for i, t := range c.Tables {
		b, err := json.Marshal(t)
		if err != nil {
			continue
		}
		used += len(b) + 1
		if used > budget {
			c.Tables = c.Tables[:i]
			c.Truncated = true
			return
		}
	}
}

// ConnectRetryFor is how long a job goes on trying while its way through Access does not serve
// its hostname yet (access.go says when that is).
const ConnectRetryFor = 45 * time.Second

// retry is what a failed connect allows next. A job straight to its server never tries again: its
// failure is the answer.
type retry int

const (
	// retryNone: the failure is the answer.
	retryNone retry = iota
	// retryRaced: the path opened by the time it was looked at; one more connect, at once.
	retryRaced
	// retryNotServed: the hostname is not served (yet); connects go on, a few seconds apart, for
	// ConnectRetryFor.
	retryNotServed
)

// connectFailure names why the driver could not connect: a certificate the job's TLS settings
// refused first, in the refusal's own words (the capture keeps them, however a driver wraps the
// handshake's error); then a login the server sent on to another address; then the engine's own
// errors (a refused login is certain), then what every engine shares. A job straight to its server
// ends there. For a job through Access, the open path then says what the failure means on it.
func (r *runner) connectFailure(ctx context.Context, eng engine.Engine, err error, path accessPath, capture *secure.Capture) (*job.Error, retry) {
	if ctx.Err() != nil {
		// The job's deadline, or a stop (SIGTERM) on its way: no other reading.
		return job.Fail("deadline", "The job reached its deadline while it connected."), retryNone
	}
	if refusal, refused := secure.Refused(err, capture); refused {
		return job.Fail("tls", "%s", refusal.Words), retryNone
	}
	if words, sentOn := r.sentOnWords(err); sentOn {
		return job.Fail("unreachable", "%s", words), retryNone
	}
	code, message, ok := eng.Classify(err)
	if !ok {
		code, message, ok = engine.ClassifyCommon(err)
	}
	if !ok {
		code, message = "unreachable", "The database did not answer: "+pull.FirstLine(err.Error())
	}
	if code == "deadline" && ctx.Err() == nil {
		// The connect's own time ran out, not the job's.
		code, message = "unreachable", "The database did not answer within 30 seconds."
	}
	if code == "deadline" || code == "login" || code == "database" || code == "tls" || path == nil {
		return job.Fail(code, "%s", message), retryNone
	}
	return path.explain(ctx, r, code, message)
}

// queryFailure names an error from a query after the connection opened.
func (r *runner) queryFailure(ctx context.Context, eng engine.Engine, err error, doing string) *job.Error {
	return r.failureOf(ctx, eng, err, doing, func(s string) string { return s })
}

// failureOf is a query's error as the job's: what the runner tried, then the database's own words,
// passed through `words` before they join the runner's (a push scrubs them of row values, and a quote
// of the runner's, as in "the batch's", must never pair with one of the database's).
func (r *runner) failureOf(ctx context.Context, eng engine.Engine, err error, doing string, words func(string) string) *job.Error {
	if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
		return job.Fail("deadline", "The job reached its deadline while it tried to %s.", doing)
	}
	if sentOn, ok := r.sentOnWords(err); ok {
		// The runner's own words, with nothing of the database's in them to pass through `words`.
		return job.Fail("unreachable", "Could not %s. %s", doing, sentOn)
	}
	if code, message, ok := eng.Classify(err); ok {
		return job.Fail(code, "Could not %s. %s", doing, words(message))
	}
	if code, message, ok := engine.ClassifyCommon(err); ok {
		return job.Fail(code, "Could not %s. %s", doing, words(message))
	}
	return job.Fail("database", "Could not %s: %s", doing, words(pull.FirstLine(err.Error())))
}

// sentOnWords is what a job answers when the server sent its login on to another address, and the
// Dialer refused: the job connects only where its connection names, whichever way it reaches its
// server. Azure SQL does that in its Redirect connection policy, and an Oracle listener that hands
// connections to another one. ok is false for any other error.
func (r *runner) sentOnWords(err error) (words string, ok bool) {
	addr, sentOn := reach.AsRedirect(err)
	if !sentOn {
		return "", false
	}
	words = fmt.Sprintf("The server sent the connection on to %s. A data job connects only to the server its connection names.", addr)
	switch r.j.Engine {
	case "sqlserver":
		words += " For Azure SQL, set the server's connection policy to Proxy."
	case "oracle":
		words += " For Oracle, name a database node's own listener: a SCAN listener, or a shared server's dispatcher, passes the connection on."
	}
	return words, true
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
