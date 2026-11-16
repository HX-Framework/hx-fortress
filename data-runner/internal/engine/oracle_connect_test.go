package engine

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"
	"testing"
	"time"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/reach"
)

type connectorFunc func(ctx context.Context) (driver.Conn, error)

func (f connectorFunc) Connect(ctx context.Context) (driver.Conn, error) { return f(ctx) }
func (connectorFunc) Driver() driver.Driver                              { return nil }

// The Oracle driver races with itself when the context of a connect ends while the connect is
// still going, so a connect runs under a context that does not end, whatever its caller's does.
func TestTheOracleConnectRunsUnderAContextThatDoesNotEnd(t *testing.T) {
	var seen context.Context
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		seen = ctx
		return nil, errors.New("no server here")
	})
	ended, end := context.WithTimeout(context.Background(), time.Millisecond)
	defer end()
	<-ended.Done()
	if _, err := (steadyConnector{inner}).Connect(ended); err == nil || err.Error() != "no server here" {
		t.Fatalf("the connect's own answer was not passed on: %v", err)
	}
	if seen.Err() != nil {
		t.Fatalf("the driver was handed a context that had ended: %v", seen.Err())
	}
	if _, has := seen.Deadline(); has {
		t.Fatal("the driver was handed a context with a deadline")
	}
}

// The job's end still ends an Oracle connect: once the job is over, opening reaches nothing and
// answers at once. The Dialer is what ends it, since the driver's own context no longer does.
func TestOracleOpensNothingForAJobThatEnded(t *testing.T) {
	accepted := make(chan struct{}, 4)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			accepted <- struct{}{}
			c.Close()
		}
	}()
	port := l.Addr().(*net.TCPAddr).Port
	ended, end := context.WithCancel(context.Background())
	end()
	spec := Spec{
		Job: job.Job{
			V: 1, ID: "dj_1", Kind: "test", Engine: "oracle", Database: "PERMITSPDB",
			Server: job.HostPort{Host: "127.0.0.1", Port: port},
			TLS:    job.TLS{Mode: "off", MinVersion: "1.2"},
			Reach:  job.Reach{Kind: "direct", Host: "127.0.0.1", Port: port},
			Login:  job.Login{Kind: "read", User: "permits_reader", Password: "an-example-password"},
		},
		Dialer: &reach.Dialer{Server: reach.ServerAddr("127.0.0.1", port), Target: l.Addr().String(), LoginFor: ConnectTimeout, Until: ended},
	}
	began := time.Now()
	db, err := (Oracle{}).Open(context.Background(), spec)
	if err == nil {
		db.Close()
		t.Fatal("a database was opened for a job that had ended")
	}
	if took := time.Since(began); took > 10*time.Second {
		t.Fatalf("opening took %s to give up", took)
	}
	select {
	case <-accepted:
		t.Fatal("the server was reached for a job that had ended")
	case <-time.After(200 * time.Millisecond):
	}
}
