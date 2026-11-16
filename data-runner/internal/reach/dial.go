// Package reach is how the runner's driver reaches a database. The Dialer lets a driver connect to
// one address, the server its job names, and to nothing else. A job straight to its server
// (`direct`) dials that address itself. A build that also has a tunnel client, in a file of the
// hosted runner's build, points the Dialer at the client's local port, and lets a job from a
// hosted container (`public`) dial only an address on the internet, by a check in another such
// file.
package reach

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Dialer connects the driver to the database. The driver is given the server's own host and port,
// so TLS checks the certificate against the server's real name; the Dialer sends that one address
// to Target and refuses every other. A server that redirects its login elsewhere, as Azure SQL does
// in its Redirect connection policy, is refused with RedirectError: a job opens no connection its
// connection did not name. The Dialer never resolves the server's name itself: Target is the
// address to connect to, and the machine's own resolver looks it up.
type Dialer struct {
	// Server is the "host:port" the driver is told to connect to.
	Server string
	// Target is where that address really goes.
	Target string
	// Timeout bounds one connect.
	Timeout time.Duration
	// LoginFor, when set, bounds everything a connection does until Settled: the driver's TLS
	// handshake and login. A driver's own read timeout would bound every query of the session
	// instead (go-mssqldb's), so the runner sets none and bounds the login here.
	LoginFor time.Duration
	// Until, when set, is the job's own context. A connection still in its login when that context
	// ends is closed, so a driver that waits for its server's first answer with no context of its
	// own (go-mssqldb's prelogin) stops with the job, at its deadline or its caller's stop, and not
	// LoginFor later. A dial ends with that context too, whatever context the driver dials with,
	// and after it nothing is dialed: the Oracle driver connects under a context that does not
	// end (engine.Oracle.Open says why), and tries its server again when a connection breaks.
	// Settled ends the watch with the login: a query is bounded by its own context.
	Until context.Context
	// Allow, when set, is asked about each address Target's name resolves to, just before the
	// Dialer connects to it, so a name that resolves to another address between two connects is
	// asked again. An error refuses the address: nothing is opened to it, and DialContext answers a
	// *RefusedError.
	Allow func(addr netip.AddrPort) error

	mu    sync.Mutex
	conns []net.Conn
	stops []func() bool
}

// RedirectError is a driver asking to connect somewhere other than its server.
type RedirectError struct{ Addr string }

// redirectWords end every RedirectError's text, so one a driver flattened into its own message is
// still known.
const redirectWords = ", which is not the address this job names"

func (e *RedirectError) Error() string {
	return fmt.Sprintf("the server sent the connection on to %s%s", e.Addr, redirectWords)
}

// AsRedirect is the redirect err holds, by its type or, for a driver that flattened it into its
// own message, by its words; ok false when it holds none.
func AsRedirect(err error) (addr string, ok bool) {
	var redirect *RedirectError
	if errors.As(err, &redirect) {
		return redirect.Addr, true
	}
	text := err.Error()
	end := strings.Index(text, redirectWords)
	if end < 0 {
		return "", false
	}
	start := strings.LastIndex(text[:end], "sent the connection on to ")
	if start < 0 {
		return "", false
	}
	return text[start+len("sent the connection on to ") : end], true
}

// RefusedError is an address Allow refused: the Dialer opened nothing to it.
type RefusedError struct {
	// Addr is the address as the Dialer was about to connect to it, "ip:port".
	Addr   string
	Reason error
}

// refusedFrom starts, and refusedWords end, every RefusedError's address in its text, so one a
// driver flattened into its own message is still known.
const (
	refusedFrom  = "did not connect to "
	refusedWords = ", an address this job may not connect to"
)

func (e *RefusedError) Error() string {
	return fmt.Sprintf("%s%s%s: %s", refusedFrom, e.Addr, refusedWords, e.Reason)
}

func (e *RefusedError) Unwrap() error { return e.Reason }

// AsRefused is the address err says Allow refused ("ip:port"), by its type or, for a driver that
// flattened it into its own message, by its words; ok false when it says none.
func AsRefused(err error) (addr string, ok bool) {
	var refused *RefusedError
	if errors.As(err, &refused) {
		return refused.Addr, true
	}
	text := err.Error()
	end := strings.Index(text, refusedWords)
	if end < 0 {
		return "", false
	}
	start := strings.LastIndex(text[:end], refusedFrom)
	if start < 0 {
		return "", false
	}
	return text[start+len(refusedFrom) : end], true
}

// DialContext connects to Target when addr is the server's address.
func (d *Dialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if !sameAddr(addr, d.Server) {
		return nil, &RedirectError{Addr: addr}
	}
	if d.Until != nil {
		if err := d.Until.Err(); err != nil {
			return nil, err
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		defer context.AfterFunc(d.Until, cancel)()
	}
	timeout := d.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	nd := net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	if allow := d.Allow; allow != nil {
		// Go calls Control with each address it resolved Target to, before it connects to that
		// one: the check sees the address the connection would really go to.
		nd.Control = func(_, address string, _ syscall.RawConn) error {
			at, err := netip.ParseAddrPort(address)
			if err == nil {
				err = allow(at)
			}
			if err != nil {
				return &RefusedError{Addr: address, Reason: err}
			}
			return nil
		}
	}
	conn, err := nd.DialContext(ctx, "tcp", d.Target)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.Until != nil {
		d.stops = append(d.stops, context.AfterFunc(d.Until, func() { _ = conn.Close() }))
	}
	if d.LoginFor > 0 {
		_ = conn.SetDeadline(time.Now().Add(d.LoginFor))
		d.conns = append(d.conns, conn)
	}
	return conn, nil
}

// sameAddr says whether two "host:port" addresses name one server. A driver may hand the Dialer
// its server's address in another spelling than the job's: go-mssqldb writes an IP address the way
// Go prints it, so "2001:DB8::5" arrives as "2001:db8::5" and "::ffff:192.0.2.5" as "192.0.2.5". Read as a
// redirect, that would refuse a connection no server ever sent on. Names compare without case.
func sameAddr(a, b string) bool {
	if a == b {
		return true
	}
	hostA, portA, errA := net.SplitHostPort(a)
	hostB, portB, errB := net.SplitHostPort(b)
	if errA != nil || errB != nil || portA != portB {
		return false
	}
	ipA, errA := netip.ParseAddr(hostA)
	ipB, errB := netip.ParseAddr(hostB)
	if errA == nil && errB == nil {
		return ipA.Unmap() == ipB.Unmap()
	}
	return errA != nil && errB != nil && strings.EqualFold(hostA, hostB)
}

// Settled lifts LoginFor's bound from the connections dialed so far, and ends Until's watch on
// them: their login is done, and a query is bounded by its own context from now on.
func (d *Dialer) Settled() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, c := range d.conns {
		_ = c.SetDeadline(time.Time{})
	}
	d.conns = nil
	for _, stop := range d.stops {
		stop()
	}
	d.stops = nil
}

// Dial is DialContext without a context, for drivers that take that shape.
func (d *Dialer) Dial(network, addr string) (net.Conn, error) {
	return d.DialContext(context.Background(), network, addr)
}

// HostName makes the Dialer a go-mssqldb HostDialer, so that driver hands it the server's name
// unresolved instead of looking the name up first.
func (d *Dialer) HostName() string {
	host, _, err := net.SplitHostPort(d.Server)
	if err != nil {
		return d.Server
	}
	return host
}

// ServerAddr is "host:port" in the form drivers build it.
func ServerAddr(host string, port int) string {
	return net.JoinHostPort(host, strconv.Itoa(port))
}
