package reach

// The Dialer: the one address a job's driver may reach, on either way.

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"
)

func TestDialerSendsOnlyTheServersAddressToTheTarget(t *testing.T) {
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
			c.Close()
		}
	}()
	d := &Dialer{Server: ServerAddr("sql-01.example.internal", 1433), Target: l.Addr().String()}
	c, err := d.DialContext(context.Background(), "tcp", "sql-01.example.internal:1433")
	if err != nil {
		t.Fatalf("the server's own address did not dial: %v", err)
	}
	c.Close()
	_, err = d.DialContext(context.Background(), "tcp", "sql-01-worker.example.internal:11003")
	var redirect *RedirectError
	if !errors.As(err, &redirect) || redirect.Addr != "sql-01-worker.example.internal:11003" {
		t.Fatalf("a redirect was not refused: %v", err)
	}
	if d.HostName() != "sql-01.example.internal" {
		t.Fatalf("host name %q", d.HostName())
	}
}

// Allow is asked about the address a connect would really go to, and a refusal opens nothing: the
// error names the address, by its type and in its words, for a driver that flattens it.
func TestDialerAsksAllowAboutTheAddressItConnectsTo(t *testing.T) {
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
			c.Close()
		}
	}()
	var asked []netip.AddrPort
	notThisOne := errors.New("not this one")
	d := &Dialer{Server: ServerAddr("db.example.internal", 5432), Target: l.Addr().String(), Allow: func(at netip.AddrPort) error {
		asked = append(asked, at)
		return notThisOne
	}}
	_, err = d.DialContext(context.Background(), "tcp", "db.example.internal:5432")
	addr, refused := AsRefused(err)
	if !refused || addr != l.Addr().String() || !errors.Is(err, notThisOne) {
		t.Fatalf("a refused address dialed, or was not named: %v", err)
	}
	if len(asked) != 1 || asked[0].String() != l.Addr().String() {
		t.Fatalf("Allow was asked about %v", asked)
	}
	if again, refused := AsRefused(errors.New("login failed: " + err.Error())); !refused || again != addr {
		t.Fatalf("a flattened refusal read as %q, %t", again, refused)
	}
	if _, refused := AsRefused(errors.New("dial tcp 192.0.2.5:5432: connection refused")); refused {
		t.Fatal("a connection the server refused read as an address the Dialer refused")
	}
	d.Allow = func(netip.AddrPort) error { return nil }
	c, err := d.DialContext(context.Background(), "tcp", "db.example.internal:5432")
	if err != nil {
		t.Fatalf("an allowed address did not dial: %v", err)
	}
	c.Close()
}

// silentListener takes connections and says nothing on them, as a server that hangs does.
func silentListener(t *testing.T) net.Listener {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var held []net.Conn
	var mu sync.Mutex
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			held = append(held, c)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		l.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range held {
			c.Close()
		}
	})
	return l
}

// A driver may hand the Dialer its server's address in another spelling than the job's: go-mssqldb
// writes an IP address the way Go prints it. That is the server, not a redirect. A name is never
// looked up to compare it.
func TestDialerKnowsItsServerInAnotherSpelling(t *testing.T) {
	l := silentListener(t)
	for _, c := range []struct {
		server, asked string
		same          bool
	}{
		{"[2001:DB8::5]:1433", "[2001:db8::5]:1433", true},
		{"[::ffff:192.0.2.5]:1433", "192.0.2.5:1433", true},
		{"[0:0:0:0:0:0:0:1]:1433", "[::1]:1433", true},
		{"SQL-01.example.internal:1433", "sql-01.example.internal:1433", true},
		{"192.0.2.5:1433", "192.0.2.6:1433", false},
		{"192.0.2.5:1433", "192.0.2.5:1434", false},
		{"[2001:db8::5]:1433", "[2001:db8::6]:1433", false},
		{"sql-01.example.internal:1433", "sql-02.example.internal:1433", false},
		{"localhost:1433", "127.0.0.1:1433", false},
		{"sql-01.example.internal:1433", "not an address", false},
	} {
		d := &Dialer{Server: c.server, Target: l.Addr().String()}
		conn, err := d.DialContext(context.Background(), "tcp", c.asked)
		if conn != nil {
			conn.Close()
		}
		var redirect *RedirectError
		if c.same && err != nil {
			t.Errorf("%s asked for as %s was refused: %v", c.server, c.asked, err)
		}
		if !c.same && (!errors.As(err, &redirect) || redirect.Addr != c.asked) {
			t.Errorf("%s asked for as %s was not refused as a redirect: %v", c.server, c.asked, err)
		}
	}
}

// A driver that waits for its server's first answer with no context of its own (go-mssqldb's
// prelogin) stops when the job does: the Dialer closes a connection still in its login. Once the
// login is done the connection is the job's to end, through its queries' own context.
func TestDialerEndsALoginWithTheJob(t *testing.T) {
	l := silentListener(t)
	server := "sql-01.example.internal:1433"

	job, end := context.WithCancel(context.Background())
	d := &Dialer{Server: server, Target: l.Addr().String(), LoginFor: time.Minute, Until: job}
	conn, err := d.DialContext(context.Background(), "tcp", server)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	read := make(chan error, 1)
	go func() {
		_, err := conn.Read(make([]byte, 1))
		read <- err
	}()
	end()
	select {
	case err := <-read:
		if err == nil {
			t.Fatal("the silent server answered")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the login went on reading after its job ended")
	}

	job, end = context.WithCancel(context.Background())
	d = &Dialer{Server: server, Target: l.Addr().String(), LoginFor: time.Minute, Until: job}
	settled, err := d.DialContext(context.Background(), "tcp", server)
	if err != nil {
		t.Fatal(err)
	}
	defer settled.Close()
	d.Settled()
	end()
	if _, err := settled.Write([]byte{0}); err != nil {
		t.Fatalf("a connection past its login was closed when the job ended: %v", err)
	}
}
