package engine

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"hx-fortress/data-runner/internal/reach"
)

// A job's pool connects more than once: after a connection broke, the next statement opens a new
// session. The Dialer bounds each login with a deadline on its connection (LoginFor), and each
// session is past that bound once its connect answered. A session the pool opened later must not
// stop answering LoginFor after it was dialed.
func TestEveryConnectOfThePoolIsSettled(t *testing.T) {
	addr := silentServer(t)
	const loginFor = 50 * time.Millisecond
	d := &reach.Dialer{Server: addr, Target: addr, LoginFor: loginFor}
	var mu sync.Mutex
	var dialed []net.Conn
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
		mu.Lock()
		dialed = append(dialed, conn)
		mu.Unlock()
		return answeredConn{make(chan struct{})}, nil
	})
	db, err := newPool(context.Background(), inner, d)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// The pool gives up its first session and opens a second one, as after a connection broke.
	db.SetConnMaxLifetime(time.Nanosecond)
	time.Sleep(2 * time.Millisecond)
	if err := db.PingContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	db.SetConnMaxLifetime(0)
	mu.Lock()
	sessions := append([]net.Conn{}, dialed...)
	mu.Unlock()
	if len(sessions) != 2 {
		t.Fatalf("the pool dialed %d connections, want 2", len(sessions))
	}
	// Past a login's time: a deadline that was left on a connection has run out by now.
	time.Sleep(loginFor + 100*time.Millisecond)
	for i, conn := range sessions {
		if _, err := conn.Write([]byte{0}); err != nil {
			t.Errorf("session %d of the pool stopped answering after its login's time: %v", i+1, err)
		}
		conn.Close()
	}
}

// A connect that failed settles nothing: its connection is still bounded as a login.
func TestAConnectThatFailedIsNotSettled(t *testing.T) {
	addr := silentServer(t)
	d := &reach.Dialer{Server: addr, Target: addr, LoginFor: 50 * time.Millisecond}
	var dialed net.Conn
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
		dialed = conn
		return nil, driver.ErrSkip
	})
	if _, err := (settling{inner, d}).Connect(context.Background()); err == nil {
		t.Fatal("the connect did not fail")
	}
	defer dialed.Close()
	time.Sleep(150 * time.Millisecond)
	if _, err := dialed.Write([]byte{0}); err == nil {
		t.Fatal("a login that failed was no longer bounded")
	}
}

// stuckPing is a session whose check round trip waits for its server and does not end with its
// context, as the Oracle driver's does: the driver asks the server to stop and goes on waiting. Only
// a closed connection ends the wait.
type stuckPing struct {
	conn    net.Conn
	pinging func()
}

func (c stuckPing) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not used") }
func (c stuckPing) Begin() (driver.Tx, error)           { return nil, errors.New("not used") }
func (c stuckPing) Close() error                        { return c.conn.Close() }
func (c stuckPing) Ping(context.Context) error {
	c.pinging()
	_, err := c.conn.Read(make([]byte, 1))
	return err
}

// A server can answer a login and then go silent, before it answers the round trip that checks the
// new connection. The job's end ends that wait too: the Dialer closes every connection of the job,
// and not only one that is still in its login. Without that, a driver that does not end a call with
// the call's context waits forever, and the job answers nothing.
func TestTheCheckOfAConnectEndsWithTheJob(t *testing.T) {
	addr := silentServer(t)
	job, end := context.WithCancel(context.Background())
	defer end()
	d := &reach.Dialer{Server: addr, Target: addr, LoginFor: ConnectTimeout, Until: job}
	pinging := make(chan struct{})
	var once sync.Once
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
		return stuckPing{conn, func() { once.Do(func() { close(pinging) }) }}, nil
	})
	opened := make(chan error, 1)
	go func() {
		db, err := newPool(job, inner, d)
		if err == nil {
			db.Close()
		}
		opened <- err
	}()
	select {
	case <-pinging:
	case err := <-opened:
		t.Fatalf("opening ended before its check began: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the pool never checked its connection")
	}
	// The login is done by now, so the connection is past its login's bound.
	if n := d.InLogin(); n != 0 {
		t.Fatalf("%d connections still in their login while the pool checks one", n)
	}
	end()
	select {
	case err := <-opened:
		if err == nil {
			t.Fatal("a database was opened though its check never answered")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the check of a connection went on waiting after its job ended")
	}
}

// Every connect of a job's pool has ConnectTimeout of its own, and a connect that failed says that
// it was a connect. A later connect has only its statement's context otherwise, which lasts as long
// as the job, and its failure reaches the job as that statement's error.
func TestEveryConnectOfThePoolHasItsOwnTimeAndSaysWhenItFailed(t *testing.T) {
	var seen context.Context
	failed := errors.New("no server here")
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		seen = ctx
		return nil, failed
	})
	began := time.Now()
	_, err := (settling{inner, nil}).Connect(context.Background())
	var connect *ConnectError
	if !errors.As(err, &connect) || !errors.Is(err, failed) || err.Error() != "no server here" {
		t.Fatalf("a connect that failed answers %#v", err)
	}
	ends, has := seen.Deadline()
	if !has {
		t.Fatal("a connect of the pool has no time of its own")
	}
	if left := ends.Sub(began); left < ConnectTimeout || left > ConnectTimeout+time.Minute {
		t.Fatalf("a connect of the pool has %s, want %s", left, ConnectTimeout)
	}
	if seen.Err() == nil {
		t.Fatal("the connect's context was left open after the connect")
	}
	// A caller that ends sooner ends the connect sooner.
	soon, endSoon := context.WithTimeout(context.Background(), time.Second)
	defer endSoon()
	_, _ = (settling{inner, nil}).Connect(soon)
	if ends, _ := seen.Deadline(); ends.Sub(began) > ConnectTimeout/2 {
		t.Fatal("a connect outlives a caller that ends before it")
	}
	// database/sql tries again when a driver says a connection is bad: it must still read that.
	bad := connectorFunc(func(context.Context) (driver.Conn, error) { return nil, driver.ErrBadConn })
	if _, err := (settling{bad, nil}).Connect(context.Background()); !errors.Is(err, driver.ErrBadConn) {
		t.Fatalf("a bad connection is no longer known as one: %v", err)
	}
	// A connect that answered is handed on as it is.
	answers := connectorFunc(func(context.Context) (driver.Conn, error) { return answeredConn{make(chan struct{})}, nil })
	conn, err := (settling{answers, nil}).Connect(context.Background())
	if err != nil || conn == nil {
		t.Fatalf("a connect that answered: %v, %v", conn, err)
	}
}
