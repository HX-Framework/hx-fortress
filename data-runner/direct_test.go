package main

// The build a customer's HX Fortress starts: it has no way through a tunnel, and makes no request
// to any service of the hosted runner's. A build that has that way skips these.

import (
	"strings"
	"testing"

	"hx-fortress/data-runner/internal/job"
)

// A job through a tunnel is refused before anything opens, and the runner asks nobody where it
// runs: the listener every HTTP request would reach stays silent.
func TestThisBuildTakesNoJobThroughAccess(t *testing.T) {
	skipWithAccess(t)
	proxy := listen(t, false)
	through := directJob(1, func(j *job.Job) {
		j.Reach = job.Reach{Kind: "access", Hostname: "db-1.example.net", ClientID: "id", ClientSecret: "the-client-secret"}
	})
	r := runIt(t, stdinRun, throughProxy(proxy), through)
	if out := r.failure(t); out.Error.Code != "not_ready" || !strings.Contains(out.Error.Message, "takes no job through a tunnel") {
		t.Fatalf("output %s", r.stdout)
	}
	if n := proxy.connections(); n != 0 {
		t.Fatalf("the runner made %d HTTP requests; this build makes none", n)
	}
}

// A job whose reach is public, which only a hosted runner checks, is refused the same way.
func TestThisBuildTakesNoPublicJob(t *testing.T) {
	skipWithAccess(t)
	proxy := listen(t, false)
	public := directJob(1, func(j *job.Job) {
		j.Reach.Kind = "public"
		j.Country = "US"
	})
	r := runIt(t, stdinRun, throughProxy(proxy), public)
	if out := r.failure(t); out.Error.Code != "not_ready" || !strings.Contains(out.Error.Message, "no job whose reach is public") {
		t.Fatalf("output %s", r.stdout)
	}
	if n := proxy.connections(); n != 0 {
		t.Fatalf("the runner made %d HTTP requests; this build makes none", n)
	}
}

// It has no `where` command, which asks an outside service where the hosted runner is.
func TestThisBuildHasNoWhereCommand(t *testing.T) {
	skipWithAccess(t)
	if r := runIt(t, []string{"where"}, nil, ""); r.exit != 2 || r.stdout != "" || !strings.Contains(r.stderr, "usage: data-runner run ["+jobStdinFlag+"] | version") {
		t.Fatalf("exit %d, stdout %q, stderr %q", r.exit, r.stdout, r.stderr)
	}
}

// skipWithAccess skips a test of the direct build in a build that has the way through a tunnel.
func skipWithAccess(t *testing.T) {
	t.Helper()
	if hosted != nil {
		t.Skip("this build has the way through a tunnel")
	}
}
