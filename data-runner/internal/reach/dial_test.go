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

// The job's end ends a dial too, whatever context a driver dials with, and after it nothing is
// dialed. The Oracle driver connects under a context that does not end with the job, and tries its
// server again when a connection breaks: without this it would open a new connection for a job
// that is over.
func TestDialerDialsNothingAfterItsJobEnded(t *testing.T) {
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
	server := "ora-01.example.internal:1521"
	job, end := context.WithCancel(context.Background())
	d := &Dialer{Server: server, Target: l.Addr().String(), LoginFor: time.Minute, Until: job}
	end()
	// The driver's own context is still open: the job's is what counts.
	conn, err := d.DialContext(context.Background(), "tcp", server)
	if err == nil {
		conn.Close()
		t.Fatal("a connection was opened for a job that had ended")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("the refusal is not the job's end: %v", err)
	}
	select {
	case <-accepted:
		t.Fatal("the server was reached for a job that had ended")
	case <-time.After(200 * time.Millisecond):
	}
}

// stuckDial is a dial that never answers by itself: it ends only when its context does, and says so
// in words of its own, as a network does. With it, a test of what ends a dial does not rest on what
// a machine's network does with an address nothing answers at. dialing is closed when it began.
func stuckDial(dialing chan struct{}) func(ctx context.Context, network, address string) (net.Conn, error) {
	return func(ctx context.Context, _, address string) (net.Conn, error) {
		close(dialing)
		<-ctx.Done()
		return nil, errors.New("dial tcp " + address + ": operation was canceled")
	}
}

// A dial that is still going when the job ends stops then, though the driver's own context goes
// on, and its answer is the job's end.
func TestDialerEndsADialWithTheJob(t *testing.T) {
	server := "ora-01.example.internal:1521"
	job, end := context.WithCancel(context.Background())
	dialing := make(chan struct{})
	d := &Dialer{Server: server, Target: "192.0.2.1:1521", Timeout: time.Minute, Until: job, dial: stuckDial(dialing)}
	done := make(chan error, 1)
	go func() {
		conn, err := d.DialContext(context.Background(), "tcp", server)
		if conn != nil {
			conn.Close()
		}
		done <- err
	}()
	<-dialing
	end()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("the dial's answer is not the job's end: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the dial went on after its job ended")
	}
}

// One connect of a driver that connects under a context that does not end (the Oracle driver) is
// ended by its Login. The server here takes the connection and never answers, as a stalled login
// does: when the Login's context ends, the connection the driver waits on is closed. The driver
// tries its server again when a connection breaks, and that dial is refused.
func TestALoginEndsItsConnect(t *testing.T) {
	l := silentListener(t)
	server := "ora-01.example.internal:1521"
	// No LoginFor and no Until: the Login alone ends this connect.
	d := &Dialer{Server: server, Target: l.Addr().String()}

	connect, end := context.WithCancel(context.Background())
	login := NewLogin(connect)
	// The driver's own context never ends.
	conn, err := d.DialContext(login.Context(context.Background()), "tcp", server)
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
		t.Fatal("the connect went on waiting after its context ended")
	}
	again, err := d.DialContext(login.Context(context.Background()), "tcp", server)
	if err == nil {
		again.Close()
		t.Fatal("a connect that was ended dialed its server again")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("the refusal is not the connect's end: %v", err)
	}
	if login.Done() {
		t.Fatal("a connect that was ended says its connection is still the caller's")
	}
}

// A connect that is over before its context ends keeps its connection: the end of that context is
// no longer the connection's. database/sql ends a connect's context as soon as the connect answers.
func TestALoginThatIsDoneLeavesItsConnectionOpen(t *testing.T) {
	l := silentListener(t)
	server := "ora-01.example.internal:1521"
	d := &Dialer{Server: server, Target: l.Addr().String()}

	connect, end := context.WithCancel(context.Background())
	login := NewLogin(connect)
	conn, err := d.DialContext(login.Context(context.Background()), "tcp", server)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if !login.Done() {
		t.Fatal("a connect whose context is open says its connection was closed")
	}
	end()
	// Were the watch still on, the close would come from another goroutine: give it the time.
	time.Sleep(50 * time.Millisecond)
	if _, err := conn.Write([]byte{0}); err != nil {
		t.Fatalf("a connection was closed after its connect was over: %v", err)
	}
}

// A dial that is still going when its connect's time runs out stops then, and its answer is that
// end: a deadline, which the runner tells apart from the job's own.
func TestALoginEndsADialThatIsStillGoing(t *testing.T) {
	server := "ora-01.example.internal:1521"
	dialing := make(chan struct{})
	d := &Dialer{Server: server, Target: "192.0.2.1:1521", Timeout: time.Minute, dial: stuckDial(dialing)}
	connect, end := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer end()
	login := NewLogin(connect)
	done := make(chan error, 1)
	go func() {
		conn, err := d.DialContext(login.Context(context.Background()), "tcp", server)
		if conn != nil {
			conn.Close()
		}
		done <- err
	}()
	<-dialing
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("the dial's answer is not the end of its connect's time: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the dial went on after its connect's time ran out")
	}
}
