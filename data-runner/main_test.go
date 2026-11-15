package main

// The runner as its caller sees it: a process that takes one job, prints one output and exits. A
// customer's HX Fortress starts it this way beside itself, for a database in its own network. These
// tests start this test binary as the runner (TestMain) and stand a listener in for the database,
// so they need no container and no server of any engine. What a job does once a real server
// answers is the integration suite's, in internal/run.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"hx-fortress/data-runner/internal/job"
)

const (
	// asRunnerEnv makes this test binary run as the data runner itself.
	asRunnerEnv = "DATA_RUNNER_TEST_AS_RUNNER"
	// stdinWaitEnv shortens how long that runner waits for a job on standard input.
	stdinWaitEnv = "DATA_RUNNER_TEST_STDIN_WAIT"
)

func TestMain(m *testing.M) {
	if os.Getenv(asRunnerEnv) == "1" {
		_ = os.Unsetenv(asRunnerEnv)
		if wait, err := time.ParseDuration(os.Getenv(stdinWaitEnv)); err == nil {
			jobStdinWait = wait
		}
		_ = os.Unsetenv(stdinWaitEnv)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// ran is what one run of the runner left behind.
type ran struct {
	stdout, stderr string
	exit           int
}

// answer is the runner's one output, with its result left as it was printed.
type answer struct {
	V      int
	ID     string
	OK     bool
	Where  *job.Where
	Result json.RawMessage
	Error  *job.Error
}

// output is the run's one output: exit code 0, and standard output that holds exactly one line, a
// JSON object that says how the job ended.
func (r ran) output(t *testing.T) answer {
	t.Helper()
	if r.exit != 0 {
		t.Fatalf("exit code %d, standard error %q", r.exit, r.stderr)
	}
	if !strings.HasSuffix(r.stdout, "\n") || strings.Count(r.stdout, "\n") != 1 {
		t.Fatalf("standard output is not one line: %q", r.stdout)
	}
	var out answer
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatalf("standard output is not an output: %v: %q", err, r.stdout)
	}
	if out.V != 1 || out.OK == (out.Error != nil) || out.OK != (out.Result != nil) {
		t.Fatalf("an output carries a result when ok and an error when not: %q", r.stdout)
	}
	return out
}

// failure is the output of a run whose job failed.
func (r ran) failure(t *testing.T) answer {
	t.Helper()
	out := r.output(t)
	if out.OK {
		t.Fatalf("the job did not fail: %q", r.stdout)
	}
	return out
}

// start starts the runner with args and only env in its environment. stdin is its standard input:
// nil gives it the null device, which ends at once.
func start(t *testing.T, args, env []string, stdin io.Reader) (*exec.Cmd, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	cmd := exec.Command(os.Args[0], args...)
	cmd.Env = append([]string{asRunnerEnv + "=1"}, env...)
	cmd.Stdin = stdin
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	return cmd, &stdout, &stderr
}

// finish waits for the runner to exit, and fails the test when it does not within a minute.
func finish(t *testing.T, cmd *exec.Cmd, stdout, stderr *bytes.Buffer) ran {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		var exited *exec.ExitError
		if err != nil && !errors.As(err, &exited) {
			t.Fatal(err)
		}
		return ran{stdout: stdout.String(), stderr: stderr.String(), exit: cmd.ProcessState.ExitCode()}
	case <-time.After(time.Minute):
		_ = cmd.Process.Kill()
		<-done
		t.Fatalf("the runner did not exit; standard error %q", stderr.String())
		return ran{}
	}
}

// runIt runs the runner to its end, with stdin written to its standard input and closed.
func runIt(t *testing.T, args, env []string, stdin string) ran {
	t.Helper()
	cmd, stdout, stderr := start(t, args, env, strings.NewReader(stdin))
	return finish(t, cmd, stdout, stderr)
}

// listener is a local port that counts the connections it takes. It closes each at once, or, when
// it holds, keeps each open and silent until the test ends.
type listener struct {
	l        net.Listener
	mu       sync.Mutex
	taken    int
	held     []net.Conn
	accepted chan struct{}
}

func listen(t *testing.T, hold bool) *listener {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &listener{l: l, accepted: make(chan struct{}, 64)}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.taken++
			if hold {
				s.held = append(s.held, c)
			} else {
				_ = c.Close()
			}
			s.mu.Unlock()
			select {
			case s.accepted <- struct{}{}:
			default:
			}
		}
	}()
	t.Cleanup(func() {
		_ = l.Close()
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, c := range s.held {
			_ = c.Close()
		}
	})
	return s
}

func (s *listener) port() int { return s.l.Addr().(*net.TCPAddr).Port }

func (s *listener) connections() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.taken
}

// throughProxy is an environment that sends every HTTP request the runner makes to proxy: a
// request to Cloudflare's trace, or to anywhere else, shows up there as a connection.
func throughProxy(proxy *listener) []string {
	url := fmt.Sprintf("http://127.0.0.1:%d", proxy.port())
	return []string{"HTTPS_PROXY=" + url, "HTTP_PROXY=" + url, "https_proxy=" + url, "http_proxy=" + url}
}

const password = "the-database-password"

// directJob is a job as an HX Fortress hands it over: straight to the server at port.
func directJob(port int, change func(j *job.Job)) string {
	j := job.Job{
		V: 1, ID: "job_0001", Kind: "test", Engine: "postgres", Database: "permits",
		Server:   job.HostPort{Host: "127.0.0.1", Port: port},
		TLS:      job.TLS{Mode: "off", MinVersion: "1.2"},
		Reach:    job.Reach{Kind: "direct", Host: "127.0.0.1", Port: port},
		Login:    job.Login{Kind: "read", User: "permits_reader", Password: password},
		Deadline: time.Now().Add(time.Minute).Format(time.RFC3339Nano),
	}
	if change != nil {
		change(&j)
	}
	raw, err := json.Marshal(j)
	if err != nil {
		panic(err)
	}
	return string(raw)
}

var stdinRun = []string{"run", jobStdinFlag}

// A job straight to its server opens that server and nothing else: no request to Cloudflare's
// trace, no tunnel client (this runner has no cloudflared and an empty PATH), nothing to anywhere.
func TestAJobStraightToItsServerOpensThatServerAndNothingElse(t *testing.T) {
	database, proxy := listen(t, false), listen(t, false)
	r := runIt(t, stdinRun, throughProxy(proxy), directJob(database.port(), nil))
	// The stand-in closes the connection at once, as no database would: the job reached it.
	if out := r.failure(t); out.ID != "job_0001" || out.Error.Code != "unreachable" || out.Where != nil || !strings.Contains(r.stdout, `"where":null`) {
		t.Fatalf("output %s", r.stdout)
	}
	if database.connections() == 0 {
		t.Fatal("the job never reached its server")
	}
	if n := proxy.connections(); n != 0 {
		t.Fatalf("the job made %d HTTP requests; it may make none", n)
	}
	for name, text := range map[string]string{"standard output": r.stdout, "standard error": r.stderr} {
		if strings.Contains(text, password) {
			t.Fatalf("the password reached %s", name)
		}
		if strings.Contains(text, "tunnel") || strings.Contains(text, "Cloudflare") {
			t.Fatalf("%s speaks of a tunnel or of Cloudflare: %q", name, text)
		}
	}
}

// Straight to its server a job cannot check where it runs, so one that names a country is refused
// when it is read: it opens nothing and asks nobody.
func TestAJobStraightToItsServerNamesNoCountry(t *testing.T) {
	database, proxy := listen(t, false), listen(t, false)
	r := runIt(t, stdinRun, throughProxy(proxy), directJob(database.port(), func(j *job.Job) { j.Country = "US" }))
	if out := r.failure(t); out.Error.Code != "internal" || !strings.Contains(out.Error.Message, "reach direct takes no country") {
		t.Fatalf("output %s", r.stdout)
	}
	if database.connections() != 0 || proxy.connections() != 0 {
		t.Fatalf("a refused job opened its server %d times and made %d HTTP requests", database.connections(), proxy.connections())
	}
}

func TestTheJobComesOnStandardInputOrInTheEnvironment(t *testing.T) {
	// A job whose deadline has passed answers at once and opens nothing.
	late := directJob(1, func(j *job.Job) { j.Deadline = "2020-01-01T00:00:00Z" })
	for name, c := range map[string]struct {
		args  []string
		env   []string
		stdin string
		code  string
		says  string
		id    string
	}{
		"on standard input":            {args: stdinRun, stdin: late, code: "deadline", says: "deadline had passed", id: "job_0001"},
		"in the environment":           {args: []string{"run"}, env: []string{job.EnvName + "=" + late}, code: "deadline", says: "deadline had passed", id: "job_0001"},
		"both ways":                    {args: stdinRun, env: []string{job.EnvName + "=" + late}, stdin: late, code: "internal", says: "both in DATA_JOB and on its standard input"},
		"no job in the environment":    {args: []string{"run"}, code: "internal", says: "without a job in DATA_JOB"},
		"nothing on standard input":    {args: stdinRun, code: "internal", says: "no job on its standard input"},
		"only spaces":                  {args: stdinRun, stdin: " \n", code: "internal", says: "no job on its standard input"},
		"more than a job's size":       {args: stdinRun, stdin: late + strings.Repeat(" ", jobMaxBytes), code: "internal", says: "larger than 1048576 bytes"},
		"a field this runner does not": {args: stdinRun, stdin: strings.Replace(late, `"v":1`, `"v":1,"extra":true`, 1), code: "internal", says: "unknown field"},
	} {
		t.Run(name, func(t *testing.T) {
			r := runIt(t, c.args, c.env, c.stdin)
			if out := r.failure(t); out.Error.Code != c.code || !strings.Contains(out.Error.Message, c.says) || out.ID != c.id {
				t.Fatalf("output %s", r.stdout)
			}
		})
	}
}

// A caller that writes the job and never closes standard input gets an output that says so.
func TestAJobThatNeverArrivesIsAnAnswerNotAWait(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	cmd, stdout, stderr := start(t, stdinRun, []string{stdinWaitEnv + "=200ms"}, read)
	if _, err := write.WriteString(directJob(1, nil)); err != nil {
		t.Fatal(err)
	}
	r := finish(t, cmd, stdout, stderr)
	if out := r.failure(t); out.Error.Code != "internal" || !strings.Contains(out.Error.Message, "No job arrived on standard input within 200ms") {
		t.Fatalf("output %s", r.stdout)
	}
}

// errReader is a standard input that cannot be read.
type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("input/output error") }

// A stop that comes while the runner still waits for its job is answered, and so is a standard
// input that cannot be read.
func TestReadingTheJobEndsWithAnAnswer(t *testing.T) {
	stopped, stop := context.WithCancel(context.Background())
	stop()
	read, write := io.Pipe()
	defer write.Close()
	if _, failure := readJob(stopped, read, 5*time.Second); failure == nil || failure.Code != "deadline" || !strings.Contains(failure.Message, "told to stop before its job arrived") {
		t.Fatalf("a stop before the job: %+v", failure)
	}
	if _, failure := readJob(context.Background(), errReader{}, time.Minute); failure == nil || failure.Code != "internal" || !strings.Contains(failure.Message, "could not be read: input/output error") {
		t.Fatalf("a standard input that cannot be read: %+v", failure)
	}
}

// Its caller stops a job with SIGTERM: the runner answers `deadline` and exits 0 at once, whatever
// its engine. The server here takes the connection and says nothing, so the job waits in its login.
// go-mssqldb reads a server's first answer with no context of its own, and until the Dialer closed
// such a connection with the job, a SQL Server job stopped only when its login's 30 seconds ran out.
func TestAStoppedJobAnswersAndExits(t *testing.T) {
	for _, engine := range job.Engines {
		t.Run(engine, func(t *testing.T) {
			database := listen(t, true)
			cmd, stdout, stderr := start(t, stdinRun, nil, strings.NewReader(directJob(database.port(), func(j *job.Job) { j.Engine = engine })))
			select {
			case <-database.accepted:
			case <-time.After(30 * time.Second):
				_ = cmd.Process.Kill()
				t.Fatalf("the job never reached its server; standard error %q", finish(t, cmd, stdout, stderr).stderr)
			}
			began := time.Now()
			if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			r := finish(t, cmd, stdout, stderr)
			if out := r.failure(t); out.ID != "job_0001" || out.Error.Code != "deadline" {
				t.Fatalf("output %s", r.stdout)
			}
			if took := time.Since(began); took > 10*time.Second {
				t.Fatalf("the job took %s to stop", took)
			}
		})
	}
}

// pgx reads the PG* variables of its process as libpq does. The runner takes them out of its own
// environment, so a job's connection is the job's alone: with a caller's PGSERVICE left in, every
// Postgres job would stop at "failed to read service".
func TestACallersPostgresVariablesChangeNothing(t *testing.T) {
	database := listen(t, false)
	env := []string{"PGSERVICE=reporting", "PGHOST=elsewhere.example.internal", "PGTARGETSESSIONATTRS=read-write"}
	r := runIt(t, stdinRun, env, directJob(database.port(), nil))
	if out := r.failure(t); out.Error.Code != "unreachable" || strings.Contains(out.Error.Message, "service") {
		t.Fatalf("output %s", r.stdout)
	}
	if database.connections() == 0 {
		t.Fatal("the job never reached the server it names")
	}
}

func TestAWrongCommandLineExitsWithTwoAndPrintsNoOutput(t *testing.T) {
	for _, args := range [][]string{nil, {"dig"}, {"run", "--stdin"}, {"run", jobStdinFlag, "more"}} {
		r := runIt(t, args, nil, "")
		if r.exit != 2 || r.stdout != "" || !strings.Contains(r.stderr, "usage: data-runner run ["+jobStdinFlag+"]") {
			t.Fatalf("%v: exit %d, stdout %q, stderr %q", args, r.exit, r.stdout, r.stderr)
		}
	}
	if r := runIt(t, []string{"version"}, nil, ""); r.exit != 0 || r.stdout != version+"\n" {
		t.Fatalf("version: exit %d, stdout %q", r.exit, r.stdout)
	}
}

// With a real Postgres named in DATA_RUNNER_IT_POSTGRES (CI's service container; the integration
// suite in internal/run says how to name one), a query goes the whole way an HX Fortress sends it: the
// job on standard input, straight to the server, its rows in the one line of standard output, and
// no HTTP request to anywhere. It reads constants in a transaction that is rolled back, so it leaves
// nothing on the server.
func TestPostgresForRealAsAProcess(t *testing.T) {
	admin := os.Getenv("DATA_RUNNER_IT_POSTGRES")
	if admin == "" {
		t.Skip("DATA_RUNNER_IT_POSTGRES is not set")
	}
	at, err := url.Parse(admin)
	if err != nil || at.Hostname() == "" || at.User == nil {
		t.Skip("DATA_RUNNER_IT_POSTGRES names no host and login: this test dials a TCP address")
	}
	port := 5432
	if at.Port() != "" {
		if port, err = strconv.Atoi(at.Port()); err != nil {
			t.Fatal(err)
		}
	}
	database := strings.TrimPrefix(at.Path, "/")
	if database == "" {
		database = "postgres"
	}
	tlsMode := os.Getenv("DATA_RUNNER_IT_POSTGRES_TLS")
	if tlsMode == "" {
		tlsMode = "require"
	}
	secret, _ := at.User.Password()
	spec := directJob(port, func(j *job.Job) {
		j.Kind, j.Database = "query", database
		j.Server.Host, j.Reach.Host = at.Hostname(), at.Hostname()
		j.TLS.Mode = tlsMode
		j.Login.User, j.Login.Password = at.User.Username(), secret
		j.Params = map[string]any{"sql": "SELECT 'BP-2026-0412' AS permit_no, 3 AS floors, NULL::text AS closed_on", "limit": 5}
	})
	proxy := listen(t, false)
	r := runIt(t, stdinRun, throughProxy(proxy), spec)
	out := r.output(t)
	var got job.QueryResult
	if !out.OK || out.ID != "job_0001" || out.Where != nil || json.Unmarshal(out.Result, &got) != nil {
		t.Fatalf("output %s", r.stdout)
	}
	if len(got.Columns) != 3 || got.Columns[0].Name != "permit_no" || len(got.Rows) != 1 ||
		got.Rows[0][0] == nil || *got.Rows[0][0] != "BP-2026-0412" || *got.Rows[0][1] != "3" || got.Rows[0][2] != nil || got.Truncated {
		t.Fatalf("result %s", r.stdout)
	}
	if n := proxy.connections(); n != 0 {
		t.Fatalf("the job made %d HTTP requests; it may make none", n)
	}
	// The rows are on standard output and nowhere else, and the login is nowhere at all.
	if strings.Contains(r.stderr, "BP-2026-0412") {
		t.Fatalf("a row's value reached standard error: %q", r.stderr)
	}
	if len(secret) >= 8 && (strings.Contains(r.stdout, secret) || strings.Contains(r.stderr, secret)) {
		t.Fatal("the password reached the runner's output")
	}
}
