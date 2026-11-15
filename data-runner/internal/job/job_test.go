package job

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The contract test's Go half: every fixture the TypeScript side also parses decodes here with no
// unknown field, validates, and encodes back to the same JSON. A field one side adds, renames or
// drops alone fails one of the two halves.
func TestContractFixturesRoundTrip(t *testing.T) {
	files, err := filepath.Glob("../../contract/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no contract fixtures found: %v", err)
	}
	for _, file := range files {
		t.Run(filepath.Base(file), func(t *testing.T) {
			data, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var again []byte
			switch {
			case strings.HasPrefix(filepath.Base(file), "job-"):
				j, err := Decode(data)
				if err != nil {
					t.Fatalf("decode: %v", err)
				}
				again, err = json.Marshal(j)
				if err != nil {
					t.Fatal(err)
				}
			case strings.HasPrefix(filepath.Base(file), "output-"):
				out, err := DecodeOutput(data)
				if err != nil {
					t.Fatalf("decode: %v", err)
				}
				if out.OK != (out.Result != nil) || out.OK == (out.Error != nil) {
					t.Fatalf("an output carries a result when ok and an error when not")
				}
				again, err = json.Marshal(out)
				if err != nil {
					t.Fatal(err)
				}
			default:
				t.Fatalf("a fixture's name starts with job- or output-")
			}
			var want, got any
			if err := json.Unmarshal(data, &want); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(again, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(want, got) {
				t.Fatalf("round trip changed the fixture:\nwant %s\ngot  %s", compact(data), again)
			}
		})
	}
}

func compact(data []byte) string {
	var b bytes.Buffer
	_ = json.Compact(&b, data)
	return b.String()
}

func validJob() Job {
	return Job{
		V: 1, ID: "dj_1", Kind: "test", Engine: "postgres", Database: "permits",
		Server:   HostPort{Host: "db.internal", Port: 5432},
		TLS:      TLS{Mode: "verify", MinVersion: "1.2"},
		Reach:    Reach{Kind: "direct", Host: "127.0.0.1", Port: 5432},
		Login:    Login{Kind: "read", User: "reader", Password: "pw"},
		Deadline: "2026-11-08T20:00:00Z",
	}
}

func TestValidateRefusesWhatTheSchemaRefuses(t *testing.T) {
	cases := map[string]func(j *Job){
		"unknown engine":            func(j *Job) { j.Engine = "db2" },
		"unknown kind":              func(j *Job) { j.Kind = "drop" },
		"strict outside SQL Server": func(j *Job) { j.TLS.Mode = "strict" },
		"no port":                   func(j *Job) { j.Server.Port = 0 },
		"access without token":      func(j *Job) { j.Reach = Reach{Kind: "access", Hostname: "db.example.net"} },
		"direct with a token":       func(j *Job) { j.Reach.ClientSecret = "x" },
		"direct with a country":     func(j *Job) { j.Country = "US" },
		"bad deadline":              func(j *Job) { j.Deadline = "tomorrow" },
		"long country":              func(j *Job) { j.Country = "USA" },
		"no user":                   func(j *Job) { j.Login.User = "" },
		"version 2":                 func(j *Job) { j.V = 2 },
		"long server name":          func(j *Job) { j.TLS.ServerName = strings.Repeat("a", ServerNameMax+1) },
		"long authority":            func(j *Job) { j.TLS.CACertificate = strings.Repeat("A", CACertificateMax+1) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			j := validJob()
			change(&j)
			if err := j.Validate(); err == nil {
				t.Fatal("validated")
			}
		})
	}
	if err := validJob().Validate(); err != nil {
		t.Fatalf("a valid job was refused: %v", err)
	}
}

func TestDecodeRefusesUnknownFieldsAndTrailingValues(t *testing.T) {
	good, _ := json.Marshal(validJob())
	withExtra := strings.Replace(string(good), `"v":1`, `"v":1,"extra":true`, 1)
	if _, err := Decode([]byte(withExtra)); err == nil {
		t.Fatal("an unknown field decoded")
	}
	if _, err := Decode(append(good, []byte(` {}`)...)); err == nil {
		t.Fatal("two values decoded")
	}
	if _, err := Decode(good); err != nil {
		t.Fatalf("a good job did not decode: %v", err)
	}
}

func TestValidateTakesAPullWithItsStoreAndAQueryWithItsSQL(t *testing.T) {
	pull := validJob()
	pull.Kind = "pull"
	if err := pull.Validate(); err == nil {
		t.Fatal("a pull with no store job validated")
	}
	pull.Store = &Store{GatewayURL: "https://gw.example", StoreID: "sto_1", JobID: "job_1", Key: "k1.x"}
	if err := pull.Validate(); err != nil {
		t.Fatalf("a pull was refused: %v", err)
	}
	query := validJob()
	query.Kind = "query"
	for _, params := range []map[string]any{nil, {"sql": " "}, {"sql": "SELECT 1", "limit": float64(201)}, {"sql": "SELECT 1", "limit": 2.5}, {"sql": 7}} {
		query.Params = params
		if err := query.Validate(); err == nil {
			t.Fatalf("a query with %v validated", params)
		}
	}
	query.Params = map[string]any{"sql": "SELECT 1", "limit": float64(20)}
	if err := query.Validate(); err != nil {
		t.Fatalf("a query was refused: %v", err)
	}
	if sql, limit := query.QuerySQL(); sql != "SELECT 1" || limit != 20 {
		t.Fatalf("QuerySQL %q %d", sql, limit)
	}
}

func TestDecodeOutputRefusesAnUnknownFieldInAResult(t *testing.T) {
	ok := []byte(`{"v":1,"id":"dj_1","ok":true,"where":null,"result":{"kind":"query","columns":[],"rows":[],"truncated":false,"ms":{"tunnel":0,"connect":0,"query":0,"total":0},"extra":1},"ms":1}`)
	if _, err := DecodeOutput(ok); err == nil {
		t.Fatal("an unknown field in a result decoded")
	}
	if _, err := DecodeOutput([]byte(`{"v":1,"id":"dj_1","ok":true,"where":null,"result":{"kind":"drop"},"ms":1}`)); err == nil {
		t.Fatal("a result of an unknown kind decoded")
	}
}

func TestDecodeTakesTheBracketsOffAnIPv6Host(t *testing.T) {
	j := validJob()
	j.Server.Host = "[2001:db8::5]"
	raw, _ := json.Marshal(j)
	got, err := Decode(raw)
	if err != nil || got.Server.Host != "2001:db8::5" {
		t.Fatalf("host %q, %v", got.Server.Host, err)
	}
	j.Server.Host = "[not an address]"
	raw, _ = json.Marshal(j)
	if got, _ := Decode(raw); got.Server.Host == "not an address" {
		t.Fatal("brackets came off a name")
	}
}

// SQL Server names the machine it runs on "." or "(local)", and go-mssqldb dials localhost for
// both. The job names what its driver will ask the Dialer for, or the Dialer would refuse it.
func TestDecodeNamesSQLServersOwnMachineAsItsDriverDoes(t *testing.T) {
	j := validJob()
	j.Engine = "sqlserver"
	j.Server.Host, j.Reach.Host = ".", "(LOCAL)"
	raw, _ := json.Marshal(j)
	got, err := Decode(raw)
	if err != nil || got.Server.Host != "localhost" || got.Reach.Host != "localhost" {
		t.Fatalf("server %q, reach %q, %v", got.Server.Host, got.Reach.Host, err)
	}
	// The two names mean nothing to another engine.
	j.Engine = "postgres"
	raw, _ = json.Marshal(j)
	if got, _ := Decode(raw); got.Server.Host != "." {
		t.Fatalf("a Postgres job's host became %q", got.Server.Host)
	}
}

// The TypeScript schema counts a string's length in UTF-16 code units, so the runner does too.
func TestLimitsCountWhatTheSchemaCounts(t *testing.T) {
	j := validJob()
	j.Database = strings.Repeat("数", 200)
	if err := j.Validate(); err != nil {
		t.Fatalf("200 characters, 600 bytes, were refused: %v", err)
	}
	j.Database = strings.Repeat("数", 257)
	if err := j.Validate(); err == nil {
		t.Fatal("257 characters were accepted")
	}
}

// DecodeOutput reads one output as strictly as the TypeScript schema does: no unknown field in it
// or its result, and the result by its kind. The runner only prints outputs: only its tests read them.
func DecodeOutput(data []byte) (Output, error) {
	var raw struct {
		V      int             `json:"v"`
		ID     string          `json:"id"`
		OK     bool            `json:"ok"`
		Where  *Where          `json:"where"`
		Result json.RawMessage `json:"result,omitempty"`
		Error  *Error          `json:"error,omitempty"`
		MS     int64           `json:"ms"`
	}
	if err := strict(data, &raw); err != nil {
		return Output{}, err
	}
	out := Output{V: raw.V, ID: raw.ID, OK: raw.OK, Where: raw.Where, Error: raw.Error, MS: raw.MS}
	if len(raw.Result) > 0 && string(raw.Result) != "null" {
		var kind struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(raw.Result, &kind); err != nil {
			return Output{}, err
		}
		var result Result
		switch kind.Kind {
		case "test":
			result = &TestResult{}
		case "pull":
			result = &PullResult{}
		case "query":
			result = &QueryResult{}
		case "push":
			result = &PushResult{}
		case "compare":
			result = &CompareResult{}
		default:
			return Output{}, fmt.Errorf("a result of kind %q", kind.Kind)
		}
		if err := strict(raw.Result, result); err != nil {
			return Output{}, err
		}
		out.Result = result
	}
	return out, nil
}

func strict(data []byte, into any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("more than one JSON value")
	}
	return nil
}
