package engine

import (
	"context"
	"database/sql/driver"
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
