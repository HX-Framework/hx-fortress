// Package job holds the data runner's wire contract: the job its caller hands the runner (as JSON
// in the environment variable DATA_JOB, or on standard input) and the one output object the runner
// prints on stdout. The caller is the api of a hosted project, or an HX Fortress that starts the
// runner beside itself. The contract's other side, in TypeScript, decodes the same fixtures
// (contract/*.json), so neither side can add, rename or drop a field alone.
package job

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

// EnvName is the environment variable the runner reads its job from. The runner clears it before
// it starts anything else, so no child process inherits it.
const EnvName = "DATA_JOB"

// Engines, kinds, logins and TLS modes, as the contract names them.
var (
	Engines     = []string{"sqlserver", "oracle", "mysql", "postgres"}
	Kinds       = []string{"test", "pull", "query", "push", "compare"}
	Logins      = []string{"read", "write"}
	TLSModes    = []string{"verify", "require", "strict", "off"}
	TLSVersions = []string{"1.0", "1.1", "1.2", "1.3"}
	ErrorCodes  = []string{
		"outside_us", "connector_offline", "access_refused", "unreachable", "tls", "login",
		"database", "deadline", "limit", "not_ready", "store", "store_limit", "internal",
	}
)

// Job is one job, as the api hands it over.
type Job struct {
	V        int      `json:"v"`
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Engine   string   `json:"engine"`
	Database string   `json:"database"`
	Server   HostPort `json:"server"`
	TLS      TLS      `json:"tls"`
	Reach    Reach    `json:"reach"`
	Login    Login    `json:"login"`
	// Deadline is an RFC 3339 instant: the runner stops then, whatever it is doing.
	Deadline string `json:"deadline"`
	// Country is the country the container must be in, as an outside service reports it to the
	// hosted runner, before the runner opens anything. Only a job from a hosted container names
	// one, through a tunnel or to an address on the internet (`public`): a job straight to its
	// server asks nobody where it runs, so it could not check a country, and one that names one
	// is refused.
	Country          string `json:"country,omitempty"`
	CatalogMaxTables int    `json:"catalogMaxTables,omitempty"`
	Store            *Store `json:"store,omitempty"`
	// Params is what a query works on ({ sql, limit }, and onlyOpenable for a statement that lists
	// databases). A pull's tables, and what a push or a compare works on, are the store job's own,
	// which the runner reads from the store.
	Params map[string]any `json:"params,omitempty"`
}

// QueryRowsMax is the most rows a query answers; QueryCellChars and QueryBytesMax cut its values
// and its answer. The contract's other side holds the same numbers.
const (
	QueryRowsMax   = 200
	QueryCellChars = 1_000
	QueryBytesMax  = 1_000_000
	QuerySQLMax    = 20_000
)

// QuerySQL is a query job's SQL and the rows it may answer.
func (j Job) QuerySQL() (string, int) {
	sql, _ := j.Params["sql"].(string)
	limit := QueryRowsMax
	if n, ok := j.Params["limit"].(float64); ok {
		limit = int(n)
	}
	return sql, limit
}

// OnlyOpenable is whether a query's rows each name a database in their first value, and the job
// answers only the rows whose database its login opens (params.onlyOpenable).
func (j Job) OnlyOpenable() bool {
	only, _ := j.Params["onlyOpenable"].(bool)
	return only
}

// HostPort is a server as the connector sees it.
type HostPort struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

func (h HostPort) String() string { return fmt.Sprintf("%s:%d", h.Host, h.Port) }

// TLS says how the driver encrypts its connection to the database.
type TLS struct {
	Mode       string `json:"mode"`
	MinVersion string `json:"minVersion"`
	// ServerName is the name the server's certificate must carry when it is not the server's host:
	// a DNS name or an address, or a Cloud SQL instance as its certificate names it,
	// `project:instance`.
	ServerName string `json:"serverName,omitempty"`
	// CACertificate is the certificate authority, in PEM, that the server's certificate must chain
	// to, in place of the system's: a Cloud SQL instance's own server CA (its server-ca.pem, which
	// holds two certificates while one replaces the other), or a company's own authority.
	CACertificate string `json:"caCertificate,omitempty"`
}

// ServerNameMax and CACertificateMax are the longest tls.serverName and tls.caCertificate, in
// UTF-16 code units, as the contract's other side counts them.
const (
	ServerNameMax    = 253
	CACertificateMax = 20_000
)

// Reach says how the runner reaches the server: `access`, through a hostname behind the hosted
// runner's tunnel, with its service token (a hosted project's connection made through it);
// `public`, from a hosted container straight to a host and port on the internet, never to an
// address of a private network (a hosted project's connection reached directly); or `direct`,
// straight to a host and port, with no tunnel, no tunnel client and no check of the address (the
// runner a customer's HX Fortress starts beside itself, in the database's own network, and a
// developer's machine). Only a hosted build takes `access` and `public`.
type Reach struct {
	Kind         string `json:"kind"`
	Hostname     string `json:"hostname,omitempty"`
	ClientID     string `json:"clientId,omitempty"`
	ClientSecret string `json:"clientSecret,omitempty"`
	Host         string `json:"host,omitempty"`
	Port         int    `json:"port,omitempty"`
}

// Login is the database login the job runs as. Its password lives in the runner's memory only.
type Login struct {
	Kind     string `json:"kind"`
	User     string `json:"user"`
	Password string `json:"password"`
}

// Store is the store job a pull, push or compare works for.
type Store struct {
	GatewayURL string `json:"gatewayUrl"`
	StoreID    string `json:"storeId"`
	JobID      string `json:"jobId"`
	Key        string `json:"key"`
}

// Decode reads one job, refusing unknown fields and anything Validate refuses.
func Decode(data []byte) (Job, error) {
	var j Job
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&j); err != nil {
		return Job{}, fmt.Errorf("the job is not valid JSON for this runner: %w", err)
	}
	if dec.More() {
		return Job{}, errors.New("the job holds more than one JSON value")
	}
	j.Server.Host = localName(j.Engine, bareHost(j.Server.Host))
	j.Reach.Host = localName(j.Engine, bareHost(j.Reach.Host))
	if err := j.Validate(); err != nil {
		return Job{}, err
	}
	return j, nil
}

func oneOf(value string, allowed []string) bool {
	for _, a := range allowed {
		if value == a {
			return true
		}
	}
	return false
}

func validPort(p int) bool { return p >= 1 && p <= 65535 }

// bareHost is an IPv6 address written in brackets ("[2001:db8::5]", as in a URL) without them: every
// driver and the Dialer join a host and a port themselves.
func bareHost(host string) string {
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") && net.ParseIP(host[1:len(host)-1]) != nil {
		return host[1 : len(host)-1]
	}
	return host
}

// localName is "localhost" for the two names SQL Server gives the machine it runs on, "." and
// "(local)". go-mssqldb dials localhost for both, and the Dialer lets a driver dial only the
// address the job names, so the job has to name what the driver will ask for.
func localName(engine, host string) string {
	if engine == "sqlserver" && (host == "." || strings.EqualFold(host, "(local)")) {
		return "localhost"
	}
	return host
}

// units is a string's length as the TypeScript schema counts it, in UTF-16 code units, so a name
// in any script has the same limit on both sides.
func units(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// Validate checks what the TypeScript schema checks, so a job one side accepts the other does too.
func (j Job) Validate() error {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	if j.V != 1 {
		add("v must be 1")
	}
	if j.ID == "" || units(j.ID) > 64 {
		add("id must be 1 to 64 characters")
	}
	if !oneOf(j.Kind, Kinds) {
		add("kind %q is not one of %s", j.Kind, strings.Join(Kinds, ", "))
	}
	if !oneOf(j.Engine, Engines) {
		add("engine %q is not one of %s", j.Engine, strings.Join(Engines, ", "))
	}
	if j.Database == "" || units(j.Database) > 256 {
		add("database must be 1 to 256 characters")
	}
	if j.Server.Host == "" || units(j.Server.Host) > 253 || !validPort(j.Server.Port) {
		add("server needs a host and a port from 1 to 65535")
	}
	if !oneOf(j.TLS.Mode, TLSModes) {
		add("tls.mode %q is not one of %s", j.TLS.Mode, strings.Join(TLSModes, ", "))
	}
	if !oneOf(j.TLS.MinVersion, TLSVersions) {
		add("tls.minVersion %q is not one of %s", j.TLS.MinVersion, strings.Join(TLSVersions, ", "))
	}
	if j.TLS.Mode == "strict" && j.Engine != "sqlserver" {
		add("tls.mode strict is SQL Server's TDS 8 only")
	}
	if units(j.TLS.ServerName) > ServerNameMax {
		add("tls.serverName must be at most %d characters", ServerNameMax)
	}
	if units(j.TLS.CACertificate) > CACertificateMax {
		add("tls.caCertificate must be at most %d characters", CACertificateMax)
	}
	switch j.Reach.Kind {
	case "access":
		if j.Reach.Hostname == "" || j.Reach.ClientID == "" || j.Reach.ClientSecret == "" {
			add("reach access needs hostname, clientId and clientSecret")
		}
		if j.Reach.Host != "" || j.Reach.Port != 0 {
			add("reach access takes no host or port")
		}
	case "direct":
		if j.Reach.Host == "" || !validPort(j.Reach.Port) {
			add("reach direct needs a host and a port from 1 to 65535")
		}
		if j.Reach.Hostname != "" || j.Reach.ClientID != "" || j.Reach.ClientSecret != "" {
			add("reach direct takes no hostname or service token")
		}
		if j.Country != "" {
			add("reach direct takes no country: only a job from a hosted container can check where it runs")
		}
	case "public":
		if j.Reach.Host == "" || !validPort(j.Reach.Port) {
			add("reach public needs a host and a port from 1 to 65535")
		}
		if j.Reach.Hostname != "" || j.Reach.ClientID != "" || j.Reach.ClientSecret != "" {
			add("reach public takes no hostname or service token")
		}
	default:
		add("reach.kind %q is not access, public or direct", j.Reach.Kind)
	}
	if !oneOf(j.Login.Kind, Logins) || j.Login.User == "" || units(j.Login.Password) > 1024 {
		add("login needs a kind (read or write), a user, and a password of at most 1024 characters")
	}
	if _, err := time.Parse(time.RFC3339Nano, j.Deadline); err != nil {
		add("deadline %q is not an RFC 3339 instant", j.Deadline)
	}
	if j.Country != "" && len(j.Country) != 2 {
		add("country must be a two-letter code")
	}
	if j.CatalogMaxTables < 0 || j.CatalogMaxTables > 100_000 {
		add("catalogMaxTables must be from 1 to 100000")
	}
	if j.Store != nil && (j.Store.GatewayURL == "" || j.Store.StoreID == "" || j.Store.JobID == "" || j.Store.Key == "") {
		add("store needs gatewayUrl, storeId, jobId and key")
	}
	if j.Kind == "pull" && j.Store == nil {
		add("a pull names the store job it writes to")
	}
	if (j.Kind == "push" || j.Kind == "compare") && j.Store == nil {
		add("a %s names the store job it works for", j.Kind)
	}
	if j.Kind == "query" {
		sql, isText := j.Params["sql"].(string)
		limit, hasLimit := j.Params["limit"]
		n, isNumber := limit.(float64)
		if !isText || strings.TrimSpace(sql) == "" || units(sql) > QuerySQLMax ||
			(hasLimit && (!isNumber || n != float64(int(n)) || n < 1 || n > QueryRowsMax)) {
			add("a query takes params.sql, and params.limit from 1 to %d", QueryRowsMax)
		}
	}
	if value, named := j.Params["onlyOpenable"]; named {
		// An Oracle job reaches the one service it names: it has no other database to open.
		only, isBool := value.(bool)
		if !isBool || j.Kind != "query" || (only && j.Engine == "oracle") {
			add("params.onlyOpenable is true or false, on a query of PostgreSQL, MySQL or SQL Server")
		}
	}
	if len(problems) > 0 {
		return errors.New("the job is not valid: " + strings.Join(problems, "; "))
	}
	return nil
}

// DeadlineTime is the job's deadline as a time.
func (j Job) DeadlineTime() time.Time {
	t, _ := time.Parse(time.RFC3339Nano, j.Deadline)
	return t
}

// Output is the one object the runner prints on stdout.
type Output struct {
	V      int    `json:"v"`
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Where  *Where `json:"where"`
	Result Result `json:"result,omitempty"`
	Error  *Error `json:"error,omitempty"`
	MS     int64  `json:"ms"`
}

// Result is what a finished job found: a *TestResult, *PullResult, *QueryResult, *PushResult or
// *CompareResult.
type Result interface{ ResultKind() string }

func (*TestResult) ResultKind() string    { return "test" }
func (*PullResult) ResultKind() string    { return "pull" }
func (*QueryResult) ResultKind() string   { return "query" }
func (*PushResult) ResultKind() string    { return "push" }
func (*CompareResult) ResultKind() string { return "compare" }

// Where is where the hosted runner's container is, as an outside service reports it.
type Where struct {
	Colo    *string `json:"colo"`
	Country *string `json:"country"`
}

// Error is why a job failed: a code from ErrorCodes and one plain sentence with no secret in it.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Fail makes an *Error.
func Fail(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// TestResult is what a test finds.
type TestResult struct {
	Kind          string     `json:"kind"`
	Login         string     `json:"login"`
	ServerVersion string     `json:"serverVersion"`
	Encryption    Encryption `json:"encryption"`
	Write         WriteCheck `json:"write"`
	Catalog       Catalog    `json:"catalog"`
	MS            TestMS     `json:"ms"`
}

// Encryption is how the driver's connection to the database was encrypted.
type Encryption struct {
	Kind     string  `json:"kind"`
	Version  *string `json:"version"`
	Cipher   *string `json:"cipher"`
	Verified bool    `json:"verified"`
}

// WriteCheck is whether the login can change anything.
type WriteCheck struct {
	CanWrite       bool     `json:"canWrite"`
	WritableCount  int      `json:"writableCount"`
	WritableTables []string `json:"writableTables"`
	Powers         []string `json:"powers"`
}

// Catalog is a database's tables, columns, keys and row estimates: never a row.
type Catalog struct {
	Engine    string  `json:"engine"`
	Database  string  `json:"database"`
	Tables    []Table `json:"tables"`
	Truncated bool    `json:"truncated"`
}

// Table is one table or view.
type Table struct {
	Schema   string   `json:"schema"`
	Name     string   `json:"name"`
	Kind     string   `json:"kind"`
	Rows     *int64   `json:"rows"`
	Columns  []Column `json:"columns"`
	Writable bool     `json:"writable"`
}

// Column is one column; Key is its place in the primary key, from 1, or 0 when it is not in it.
type Column struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	Key      int    `json:"key,omitempty"`
}

// PullResult is what a pull did, from the runner's side: what it read and sent of each table. The
// rows went to the store, whose own job answers what it wrote.
type PullResult struct {
	Kind   string        `json:"kind"`
	Tables []PulledTable `json:"tables"`
	MS     PullMS        `json:"ms"`
}

// PulledTable is one table of a pull.
type PulledTable struct {
	Source  string `json:"source"`
	Into    string `json:"into"`
	Mode    string `json:"mode"`
	Read    int64  `json:"read"`
	Sent    int64  `json:"sent"`
	Removed int64  `json:"removed"`
	Pages   int64  `json:"pages"`
	Cut     int64  `json:"cut"`
	MS      int64  `json:"ms"`
}

// PullMS says where a pull's time went, in milliseconds.
type PullMS struct {
	Tunnel  int64 `json:"tunnel"`
	Connect int64 `json:"connect"`
	Total   int64 `json:"total"`
}

// QueryResult is one query's answer: its columns, and its rows' values as text.
type QueryResult struct {
	Kind      string        `json:"kind"`
	Columns   []QueryColumn `json:"columns"`
	Rows      [][]*string   `json:"rows"`
	Truncated bool          `json:"truncated"`
	MS        QueryMS       `json:"ms"`
}

// QueryColumn is a column of a query's answer.
type QueryColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// QueryMS says where a query's time went, in milliseconds.
type QueryMS struct {
	Tunnel  int64 `json:"tunnel"`
	Connect int64 `json:"connect"`
	Query   int64 `json:"query"`
	Total   int64 `json:"total"`
}

// PushResult is what a push did, from the runner's side: the batches it wrote and how their rows
// ended. The store's own job answers what it kept.
type PushResult struct {
	Kind     string `json:"kind"`
	Batches  int64  `json:"batches"`
	Inserted int64  `json:"inserted"`
	Updated  int64  `json:"updated"`
	Deleted  int64  `json:"deleted"`
	Held     int64  `json:"held"`
	MS       PullMS `json:"ms"`
}

// CompareResult is what a push's preview or a compare did, from the runner's side: the store's rows
// it read, the database's table's rows, the rows it sent the store, the keys the same on both sides,
// and the database's rows of no key of this store's.
type CompareResult struct {
	Kind string `json:"kind"`
	// Job is the store job's kind: push_preview or compare.
	Job        string `json:"job"`
	Read       int64  `json:"read"`
	TargetRows int64  `json:"targetRows"`
	Sent       int64  `json:"sent"`
	Same       int64  `json:"same"`
	OtherRows  int64  `json:"otherRows"`
	MS         PullMS `json:"ms"`
}

// TestMS says where a test's time went, in milliseconds.
type TestMS struct {
	Tunnel  int64 `json:"tunnel"`
	Connect int64 `json:"connect"`
	Catalog int64 `json:"catalog"`
	Total   int64 `json:"total"`
}

// Str is a helper for the contract's nullable strings.
func Str(s string) *string { return &s }

// StrOrNil is nil for an empty string.
func StrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
