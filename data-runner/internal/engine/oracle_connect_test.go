package engine

import (
	"context"
	"database/sql/driver"
	"encoding/binary"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/reach"
)

// No test here waits for a real deadline to pass before it can go on: a connect's time runs out
// when the test says so (timedOut), and a step that has to come first is waited for on a channel.
// A test that rests on a number of milliseconds fails on a machine that is slow for a moment. The
// sleeps that are left give a wrong build time to do harm, and a right build passes without them.

type connectorFunc func(ctx context.Context) (driver.Conn, error)

func (f connectorFunc) Connect(ctx context.Context) (driver.Conn, error) { return f(ctx) }
func (connectorFunc) Driver() driver.Driver                              { return nil }

// timedOut is a context whose time runs out when a test says so, and not when a clock does.
type timedOut struct {
	context.Context
	done chan struct{}
}

func newTimedOut() *timedOut { return &timedOut{context.Background(), make(chan struct{})} }

func (c *timedOut) Done() <-chan struct{} { return c.done }
func (c *timedOut) Err() error {
	select {
	case <-c.done:
		return context.DeadlineExceeded
	default:
		return nil
	}
}

// runOut ends the context as a deadline does.
func (c *timedOut) runOut() { close(c.done) }

// timed is a connect's own time for steadyConnector, in the test's hands.
func (c *timedOut) timed(context.Context) (context.Context, context.CancelFunc) {
	return c, func() {}
}

// answeredConn is a connection a driver hands back; closed is closed when it is.
type answeredConn struct{ closed chan struct{} }

func (c answeredConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not used") }
func (c answeredConn) Begin() (driver.Tx, error)           { return nil, errors.New("not used") }
func (c answeredConn) Close() error {
	close(c.closed)
	return nil
}

// silentServer takes connections and never answers, as a server whose login stalls. It answers
// the address it listens on.
func silentServer(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var held []net.Conn
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
	return l.Addr().String()
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
	if _, err := (steadyConnector{inner, connectTimed}).Connect(caller); err == nil || err.Error() != "no server here" {
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
	if _, err := (steadyConnector{inner, connectTimed}).Connect(ended); !errors.Is(err, context.Canceled) {
		t.Fatalf("the answer of a connect that was ended is not its end: %v", err)
	}
}

// A connect's own time is ConnectTimeout, or what is left of its caller's when that is less.
func TestAConnectHasConnectTimeoutOfItsOwn(t *testing.T) {
	began := time.Now()
	ctx, cancel := connectTimed(context.Background())
	defer cancel()
	ends, has := ctx.Deadline()
	if !has {
		t.Fatal("a connect has no time of its own")
	}
	if left := ends.Sub(began); left < ConnectTimeout || left > ConnectTimeout+time.Minute {
		t.Fatalf("a connect has %s, want %s", left, ConnectTimeout)
	}
	soon, end := context.WithTimeout(context.Background(), time.Second)
	defer end()
	sooner, cancel := connectTimed(soon)
	defer cancel()
	if ends, _ := sooner.Deadline(); ends.Sub(began) > time.Minute/2 {
		t.Fatal("a connect outlives a caller that ends before it")
	}
	if ConnectTimeout != 30*time.Second {
		t.Fatalf("ConnectTimeout is %s: a job says \"within 30 seconds\"", ConnectTimeout)
	}
}

// A connect that takes longer than its time ends then, though its caller's context goes on: a
// query's context lasts as long as its job, and a job may run for half an hour. The server here
// takes the connection and never answers, and the connect waits for it as the driver does.
func TestAnOracleConnectEndsWhenItsTimeRunsOut(t *testing.T) {
	addr := silentServer(t)
	d := &reach.Dialer{Server: addr, Target: addr}
	waiting := make(chan struct{})
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
		defer conn.Close()
		close(waiting)
		_, err = conn.Read(make([]byte, 1))
		return nil, err
	})
	clock := newTimedOut()
	answered := make(chan error, 1)
	go func() {
		_, err := (steadyConnector{inner, clock.timed}).Connect(context.Background())
		answered <- err
	}()
	select {
	case <-waiting:
	case err := <-answered:
		t.Fatalf("the connect ended before it waited for the server: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the connect never reached the server")
	}
	clock.runOut()
	select {
	case err := <-answered:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("the answer is not the end of the connect's time: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the connect went on after its time ran out")
	}
}

// A connect whose time ran out as the driver answered has lost its connection: the Dialer closed
// it. So the driver's answer is not handed on. Its connection is closed, and the connect answers
// its end.
func TestAnOracleConnectThatEndedAsItAnsweredIsNotHandedOn(t *testing.T) {
	addr := silentServer(t)
	d := &reach.Dialer{Server: addr, Target: addr}
	waiting := make(chan struct{})
	closed := make(chan struct{})
	inner := connectorFunc(func(ctx context.Context) (driver.Conn, error) {
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
		close(waiting)
		// Waits until the Dialer closes the connection, and answers as if the login were done.
		_, _ = conn.Read(make([]byte, 1))
		return answeredConn{closed}, nil
	})
	clock := newTimedOut()
	type answer struct {
		conn driver.Conn
		err  error
	}
	answered := make(chan answer, 1)
	go func() {
		conn, err := (steadyConnector{inner, clock.timed}).Connect(context.Background())
		answered <- answer{conn, err}
	}()
	select {
	case <-waiting:
	case a := <-answered:
		t.Fatalf("the connect ended before it waited for the server: %v", a.err)
	case <-time.After(10 * time.Second):
		t.Fatal("the connect never reached the server")
	}
	clock.runOut()
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
	addr := silentServer(t)
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
	clock := newTimedOut()
	conn, err := (steadyConnector{inner, clock.timed}).Connect(context.Background())
	if err != nil || conn == nil {
		t.Fatalf("the connect failed: %v", err)
	}
	defer dialed.Close()
	clock.runOut()
	// A watch that was left on would close the connection from another goroutine: give it the time.
	time.Sleep(100 * time.Millisecond)
	if _, err := dialed.Write([]byte{0}); err != nil {
		t.Fatalf("the connection of a connect that answered was closed: %v", err)
	}
}

// saidGoodbye reads what an Oracle driver wrote to a server before its login was done, and says
// whether the driver told the server it was leaving. Before the login, a packet starts with its
// length in two bytes and has its type in the fifth; a data packet (type 6) has two bytes of flags
// after its eight-byte header, and the flag 0x40 is the driver's last word (go-ora v2.9.0,
// network: Packet.bytes, DataPacket.bytes and Session.WriteFinalPacket). What is left of a packet
// that was cut off is no packet.
func saidGoodbye(wrote []byte) bool {
	for at := 0; len(wrote)-at >= 8; {
		length := int(binary.BigEndian.Uint16(wrote[at:]))
		if length < 8 || at+length > len(wrote) {
			return false
		}
		if wrote[at+4] == 6 && length >= 10 && binary.BigEndian.Uint16(wrote[at+8:])&0x40 != 0 {
			return true
		}
		at += length
	}
	return false
}

func TestTheDriversLastWordIsKnown(t *testing.T) {
	connect := make([]byte, 70)
	binary.BigEndian.PutUint16(connect, 70)
	connect[4] = 1
	goodbye := []byte{0, 10, 0, 0, 6, 0, 0, 0, 0, 0x40}
	data := []byte{0, 12, 0, 0, 6, 0, 0, 0, 0, 0, 0x40, 0x40}
	for _, c := range []struct {
		name  string
		wrote []byte
		said  bool
	}{
		{"nothing", nil, false},
		{"its first packet", connect, false},
		{"its first packet, and data that holds the flag's byte", append(append([]byte{}, connect...), data...), false},
		{"its first packet, then its last word", append(append([]byte{}, connect...), goodbye...), true},
		{"a last word that was cut off", append(append([]byte{}, connect...), goodbye[:9]...), false},
	} {
		if got := saidGoodbye(c.wrote); got != c.said {
			t.Errorf("%s: %v, want %v", c.name, got, c.said)
		}
	}
}

// A stalled Oracle login ends with its connect: at the caller's stop, at its deadline, or
// ConnectTimeout after it began. The server here takes the connection and the driver's first
// packet, and never answers. The job goes on, so only the connect's own context can end the wait.
//
// The driver is not told of that end, because it would race with itself: the Dialer closes the
// connection instead. So the answer is the context's own end, and the driver never tells the
// server that it is leaving. Told of the end, the driver writes a last packet before it closes.
func TestAStalledOracleLoginEndsWithItsConnect(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	heard := make(chan struct{})  // the server has the driver's first packet whole
	wrote := make(chan []byte, 1) // everything the driver wrote, to the connection's end
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		var all []byte
		told := false
		buf := make([]byte, 4096)
		for {
			n, err := c.Read(buf)
			all = append(all, buf[:n]...)
			if !told && len(all) >= 8 && len(all) >= int(binary.BigEndian.Uint16(all)) {
				told = true
				close(heard)
			}
			if err != nil {
				break
			}
		}
		wrote <- all
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
		t.Fatalf("opening ended before the server had the driver's first packet: %v", err)
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
	case all := <-wrote:
		if saidGoodbye(all) {
			t.Fatalf("the driver was told that its connect ended: it wrote its last packet to the server (%d bytes in all)", len(all))
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
	db, err := (Oracle{}).Open(context.Background(), spec)
	if err == nil {
		db.Close()
		t.Fatal("a database was opened for a job that had ended")
	}
	// A wrong build would reach the server from the driver's own goroutine: give it the time.
	select {
	case <-accepted:
		t.Fatal("the server was reached for a job that had ended")
	case <-time.After(200 * time.Millisecond):
	}
}
