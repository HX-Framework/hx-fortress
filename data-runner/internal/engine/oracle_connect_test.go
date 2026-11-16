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
// still going, so the driver is handed a context that does not end, whatever its caller's does.
func TestTheOracleDriverIsHandedAContextThatDoesNotEnd(t *testing.T) {
	var seen context.Context
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		seen = ctx
		return nil, errors.New("no server here")
	})
	// The caller's context has a deadline, as the first connect of a job has.
	caller, end := context.WithTimeout(context.Background(), time.Hour)
	defer end()
	if _, err := (steadyConnector{inner, time.Hour}).Connect(caller); err == nil || err.Error() != "no server here" {
		t.Fatalf("the connect's own answer was not passed on: %v", err)
	}
	end()
	if seen.Done() != nil {
		t.Fatal("the driver was handed a context that can end")
	}
	if _, has := seen.Deadline(); has {
		t.Fatal("the driver was handed a context with a deadline")
	}
}

// A connect that was ended answers with its end. The driver's own words for a connection that was
// closed under it say nothing of a deadline, and the runner tells a connect whose time ran out
// from one a server refused.
func TestAnOracleConnectThatWasEndedAnswersItsEnd(t *testing.T) {
	inner := connectorFunc(func(context.Context) (driver.Conn, error) {
		return nil, errors.New("read tcp 127.0.0.1:50000->127.0.0.1:1521: use of closed network connection")
	})
	ended, end := context.WithCancel(context.Background())
	end()
	if _, err := (steadyConnector{inner, time.Hour}).Connect(ended); !errors.Is(err, context.Canceled) {
		t.Fatalf("the answer of a connect that was ended is not its end: %v", err)
	}
}

// A connect that takes longer than its time ends then, though its caller's context goes on: a
// query's context lasts as long as its job, and a job may run for half an hour. The server here
// takes the connection and never answers, and the connect waits for it as the driver does.
func TestAnOracleConnectEndsWhenItsTimeRunsOut(t *testing.T) {
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
			defer c.Close()
		}
	}()
	addr := l.Addr().String()
	d := &reach.Dialer{Server: addr, Target: addr}
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
		defer conn.Close()
		_, err = conn.Read(make([]byte, 1))
		return nil, err
	})
	answered := make(chan error, 1)
	go func() {
		_, err := (steadyConnector{inner, 100 * time.Millisecond}).Connect(context.Background())
		answered <- err
	}()
	select {
	case err := <-answered:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("the answer is not the end of the connect's time: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the connect went on after its time ran out")
	}
}

// answeredConn is a connection a driver hands back; closed is closed when it is.
type answeredConn struct{ closed chan struct{} }

func (c answeredConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not used") }
func (c answeredConn) Begin() (driver.Tx, error)           { return nil, errors.New("not used") }
func (c answeredConn) Close() error {
	close(c.closed)
	return nil
}

// A connect whose time ran out as the driver answered has lost its connection: the Dialer closed
// it. So the driver's answer is not handed on. Its connection is closed, and the connect answers
// its end.
func TestAnOracleConnectThatEndedAsItAnsweredIsNotHandedOn(t *testing.T) {
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
			defer c.Close()
		}
	}()
	addr := l.Addr().String()
	d := &reach.Dialer{Server: addr, Target: addr}
	closed := make(chan struct{})
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
		// Waits until the Dialer closes the connection, and answers as if the login were done.
		_, _ = conn.Read(make([]byte, 1))
		return answeredConn{closed}, nil
	})
	type answer struct {
		conn driver.Conn
		err  error
	}
	answered := make(chan answer, 1)
	go func() {
		conn, err := (steadyConnector{inner, 100 * time.Millisecond}).Connect(context.Background())
		answered <- answer{conn, err}
	}()
	select {
	case a := <-answered:
		if a.conn != nil || !errors.Is(a.err, context.DeadlineExceeded) {
			t.Fatalf("a connection that was closed under the driver was handed on: %v, %v", a.conn, a.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the connect went on after its time ran out")
	}
	select {
	case <-closed:
	default:
		t.Fatal("the driver's connection was left open")
	}
}

// A connect that answered in time keeps its connection: database/sql ends a connect's context as
// soon as the connect answers, and the connect's own time ends later, and neither may close a
// connection that is now a session of the job's.
func TestAnOracleConnectThatAnsweredKeepsItsConnection(t *testing.T) {
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
			defer c.Close()
		}
	}()
	addr := l.Addr().String()
	d := &reach.Dialer{Server: addr, Target: addr}
	var dialed net.Conn
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
		dialed = conn
		return answeredConn{make(chan struct{})}, nil
	})
	caller, end := context.WithCancel(context.Background())
	conn, err := (steadyConnector{inner, 100 * time.Millisecond}).Connect(caller)
	if err != nil || conn == nil {
		t.Fatalf("the connect failed: %v", err)
	}
	defer dialed.Close()
	end()
	// Past the caller's end and the connect's own time: a watch left on would close it by now.
	time.Sleep(200 * time.Millisecond)
	if _, err := dialed.Write([]byte{0}); err != nil {
		t.Fatalf("the connection of a connect that answered was closed: %v", err)
	}
}

// oracleJob is a job for an Oracle server that listens on this machine.
func oracleJob(port int) job.Job {
	return job.Job{
		V: 1, ID: "dj_1", Kind: "test", Engine: "oracle", Database: "PERMITSPDB",
		Server: job.HostPort{Host: "127.0.0.1", Port: port},
		TLS:    job.TLS{Mode: "off", MinVersion: "1.2"},
		Reach:  job.Reach{Kind: "direct", Host: "127.0.0.1", Port: port},
		Login:  job.Login{Kind: "read", User: "permits_reader", Password: "an-example-password"},
	}
}

// A stalled Oracle login ends with its connect: at the caller's stop, at its deadline, or
// ConnectTimeout after it began. The server here takes the connection and the driver's first
// words, and never answers. The job goes on, so only the connect's own context can end the wait.
//
// The driver is not told of that end, because it would race with itself: the Dialer closes the
// connection instead. So the answer is the context's own end, and the driver writes nothing more
// to the server. Told of the end, the driver would write a last packet before it closed.
func TestAStalledOracleLoginEndsWithItsConnect(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	heard := make(chan struct{}) // the server has the driver's first words, and the driver waits
	after := make(chan int, 1)   // the bytes the server read after that, to the connection's end
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 4096)
		if _, err := c.Read(buf); err != nil {
			return
		}
		// The driver's first words may come in more than one read: take what follows at once.
		for {
			_ = c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
			if _, err := c.Read(buf); err != nil {
				break
			}
		}
		_ = c.SetReadDeadline(time.Time{})
		close(heard)
		n := 0
		for {
			m, err := c.Read(buf)
			n += m
			if err != nil {
				break
			}
		}
		after <- n
	}()
	port := l.Addr().(*net.TCPAddr).Port
	spec := Spec{
		Job:    oracleJob(port),
		Dialer: &reach.Dialer{Server: reach.ServerAddr("127.0.0.1", port), Target: l.Addr().String(), LoginFor: ConnectTimeout, Until: context.Background()},
	}
	connect, giveUp := context.WithCancel(context.Background())
	defer giveUp()
	opened := make(chan error, 1)
	go func() {
		db, err := (Oracle{}).Open(connect, spec)
		if err == nil {
			db.Close()
		}
		opened <- err
	}()
	select {
	case <-heard:
	case err := <-opened:
		t.Fatalf("opening ended before the server was silent: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the driver sent the server nothing")
	}
	giveUp()
	select {
	case err := <-opened:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("the answer is not the end of the connect: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the login went on waiting after its connect was given up")
	}
	select {
	case n := <-after:
		if n != 0 {
			t.Fatalf("the driver wrote %d bytes to the server after its connect ended", n)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the connection to the server was left open")
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
		Job:    oracleJob(port),
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
