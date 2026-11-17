package run

import (
	"context"
	"sync"

	"hx-fortress/data-runner/internal/engine"
	"hx-fortress/data-runner/internal/reach"
	"hx-fortress/data-runner/internal/secure"
)

// openable keeps the rows whose database the job's login opens (params.onlyOpenable). Each row
// names a database in its first value, and openable opens each one the way the job opened its own:
// the same server, the same way to it, the same TLS and the same login. A database the server
// refused is left out of the answer.
//
// A statement can read which databases a login may connect to by privilege, but not every rule a
// server keeps: Postgres's pg_hba.conf can refuse a database the login holds CONNECT on, and the
// login cannot read that file. Only the server can say, so each database is opened once and closed
// at once.
//
// A database whose open failed for another reason stays in the answer: a busy server, a broken
// path or the end of this step's time says nothing about the database. The job's own database was
// opened already and is not opened again. A row with no database in it is left out.
func (r *runner) openable(ctx context.Context, eng engine.Engine, spec engine.Spec, rows [][]*string) [][]*string {
	ctx, cancel := context.WithTimeout(ctx, OpenEachFor)
	defer cancel()
	refused := make([]bool, len(rows))
	slots := make(chan struct{}, OpenEachAtOnce)
	var wg sync.WaitGroup
	for i, row := range rows {
		if len(row) == 0 || row[0] == nil {
			refused[i] = true
			continue
		}
		if *row[0] == r.j.Database {
			continue
		}
		wg.Add(1)
		go func(i int, database string) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-slots }()
			refused[i] = refuses(ctx, eng, spec, database)
		}(i, *row[0])
	}
	wg.Wait()
	kept := make([][]*string, 0, len(rows))
	for i, row := range rows {
		if !refused[i] {
			kept = append(kept, row)
		}
	}
	if out := len(rows) - len(kept); out > 0 {
		r.logf("left out %d of %d databases: the server refused this login on them", out, len(rows))
	}
	return kept
}

// refuses opens database the way spec opened the job's own, and closes it at once. It is true when
// the server refused this login on that database.
func refuses(ctx context.Context, eng engine.Engine, spec engine.Spec, database string) bool {
	probe := spec
	probe.Job.Database = database
	// A Dialer keeps its own connections, so each database gets one of its own, ending with this
	// step.
	probe.Dialer = &reach.Dialer{
		Server:   spec.Dialer.Server,
		Target:   spec.Dialer.Target,
		Timeout:  spec.Dialer.Timeout,
		LoginFor: spec.Dialer.LoginFor,
		Until:    ctx,
		Allow:    spec.Dialer.Allow,
	}
	probe.Capture = &secure.Capture{}
	db, err := eng.Open(ctx, probe)
	if err != nil {
		return eng.Refused(err)
	}
	_ = db.Close()
	return false
}
