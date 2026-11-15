// The data runner: the program that does one data job on a database (SQL Server, Oracle, MySQL or
// Postgres) and answers one output. Its caller starts it once for each job.
//
//	data-runner run               read the job from DATA_JOB, do it, print one output object on stdout
//	data-runner run --job-stdin   the same, with the job read from standard input
//	data-runner version           print the runner's version
//
// A job reaches its database straight at the host and port it names. A build that also has the way
// through a tunnel, which the hosted runner's build holds in files of its own, adds a tunnel
// client, and the command `where`.
//
// A caller hands the job over on standard input where it can: on Linux a process's first
// environment stays readable in /proc/<pid>/environ for as long as it runs, even after the runner
// clears the variable, and the job holds a login.
//
// Progress goes to stderr, with no login, token or row in it. When DATA_RUNNER_STAGES names a file,
// the runner also appends a stage line there as it starts each step (each connect, reading a
// test's tables), which its caller reads while the job runs. The exit code is 0 whenever an output
// was printed, even for a job that failed: the output says how it ended.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"hx-fortress/data-runner/internal/job"
	"hx-fortress/data-runner/internal/run"
)

// version is set at build time with -ldflags "-X main.version=…".
var version = "dev"

// commands are what the runner does, by name, and usageWords how the usage line names them. A
// build with the way through a tunnel adds `where`.
var (
	commands = map[string]func(args []string) int{
		"run": runJob,
		"version": func([]string) int {
			fmt.Println(version)
			return 0
		},
	}
	usageWords = []string{"run [" + jobStdinFlag + "]", "version"}
)

// hosted, when a build sets it, adds to a job's pieces what a hosted job's runner has and one
// that an HX Fortress starts does not: the hosted runner's own ways to a database.
var hosted func(d *run.Deps)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	command, known := commands[os.Args[1]]
	if !known {
		usage()
	}
	os.Exit(command(os.Args[2:]))
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: data-runner "+strings.Join(usageWords, " | "))
	os.Exit(2)
}

// jobStdinFlag makes `run` read its job from standard input, in place of DATA_JOB.
const jobStdinFlag = "--job-stdin"

// jobMaxBytes is the most bytes a job on standard input may hold. No job comes near it: its
// statement and its certificate authority are at most 20,000 characters each.
const jobMaxBytes = 1 << 20

// jobStdinWait is how long `run --job-stdin` waits for its job. A caller writes the job and closes
// standard input at once; one that forgets to close it gets an output that says so, not a process
// that waits for ever.
var jobStdinWait = 30 * time.Second

func runJob(args []string) int {
	fromStdin := false
	switch {
	case len(args) == 0:
	case len(args) == 1 && args[0] == jobStdinFlag:
		fromStdin = true
	default:
		usage()
	}
	raw := os.Getenv(job.EnvName)
	// The job holds a login and a service token: nothing started from here may inherit it.
	_ = os.Unsetenv(job.EnvName)
	clearDriverEnv()
	// Before the job is read: a caller that stops the runner while it still waits for its job gets
	// an answer too.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if fromStdin {
		if raw != "" {
			return printOutput(job.Output{V: 1, Error: job.Fail("internal", "The runner was given a job both in %s and on its standard input.", job.EnvName)})
		}
		read, failure := readJob(ctx, os.Stdin, jobStdinWait)
		if failure != nil {
			return printOutput(job.Output{V: 1, Error: failure})
		}
		raw = read
	} else if raw == "" {
		return printOutput(job.Output{V: 1, Error: job.Fail("internal", "The runner was started without a job in %s.", job.EnvName)})
	}
	j, err := job.Decode([]byte(raw))
	if err != nil {
		// A job that does not decode has no id worth trusting.
		return printOutput(job.Output{V: 1, Error: job.Fail("internal", "%s", err)})
	}
	if os.Getenv("GOMEMLIMIT") == "" {
		// With no limit named the runner aims low: 160 MiB, and 3 GiB for a pull, where a table's
		// hashes take about 100 bytes a row. The collector then works harder before a small machine's
		// limit, not after it. A caller with another machine names its own limit in GOMEMLIMIT.
		limit := int64(160 << 20)
		if j.Kind == "pull" {
			limit = 3 << 30
		}
		debug.SetMemoryLimit(limit)
	}
	d := run.Production(os.Stderr)
	if hosted != nil {
		hosted(&d)
	}
	if stages := stageFile(); stages != nil {
		defer stages.Close()
		d.Stages = stages
	}
	return printOutput(run.Run(ctx, j, d))
}

// clearDriverEnv takes the PG* variables out of the runner's environment. pgx reads them as libpq
// does, and a job's connection is the job's alone: a caller's own PGSERVICE would stop every
// Postgres job, and its PGTARGETSESSIONATTRS would change which servers a connect accepts. An
// HX Fortress keeps its own data in Postgres, so its environment is likely to hold some.
func clearDriverEnv() {
	for _, pair := range os.Environ() {
		if name, _, _ := strings.Cut(pair, "="); strings.HasPrefix(name, "PG") {
			_ = os.Unsetenv(name)
		}
	}
}

// readJob reads the job a caller wrote to standard input and closed, within wait, unless ctx ends
// first: the runner was told to stop.
func readJob(ctx context.Context, in io.Reader, wait time.Duration) (string, *job.Error) {
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(in, jobMaxBytes+1))
		done <- result{data, err}
	}()
	select {
	case r := <-done:
		switch {
		case r.err != nil:
			return "", job.Fail("internal", "The job on standard input could not be read: %s.", r.err)
		case len(r.data) > jobMaxBytes:
			return "", job.Fail("internal", "The job on standard input is larger than %d bytes.", jobMaxBytes)
		case strings.TrimSpace(string(r.data)) == "":
			return "", job.Fail("internal", "The runner was started with %s and no job on its standard input.", jobStdinFlag)
		}
		return string(r.data), nil
	case <-ctx.Done():
		return "", job.Fail("deadline", "The runner was told to stop before its job arrived on standard input.")
	case <-time.After(wait):
		return "", job.Fail("internal", "No job arrived on standard input within %s: its caller writes the job there, then closes it.", wait)
	}
}

// stageFile is the file DATA_RUNNER_STAGES names, opened to append stage lines, or nil when it
// names none or cannot be opened: a job runs the same without its stages.
func stageFile() *os.File {
	path := os.Getenv(stagesEnv)
	if path == "" {
		return nil
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "data-runner: the stage file did not open:", err)
		return nil
	}
	return f
}

// stagesEnv names the file stage lines go to.
const stagesEnv = "DATA_RUNNER_STAGES"

func printOutput(out job.Output) int {
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "data-runner: the output did not print:", err)
		return 1
	}
	return 0
}
