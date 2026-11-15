package engine

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestQuoteDoublesTheEnginesOwnQuote(t *testing.T) {
	cases := map[string]string{
		"postgres":  `"we""ird"`,
		"oracle":    `"we""ird"`,
		"mysql":     "`we\"ird`",
		"sqlserver": `[we"ird]`,
	}
	for engine, want := range cases {
		if got := Quote(engine, `we"ird`); got != want {
			t.Errorf("%s: %s, want %s", engine, got, want)
		}
	}
	if got := Quote("sqlserver", "a]b"); got != "[a]]b]" {
		t.Errorf("sqlserver: %s", got)
	}
	if got := Quote("mysql", "a`b"); got != "`a``b`" {
		t.Errorf("mysql: %s", got)
	}
	if got := Table("sqlserver", "dbo", "Permits"); got != "[dbo].[Permits]" {
		t.Errorf("table: %s", got)
	}
}

func TestSelectReadsOraclesNumbersAsTextOnly(t *testing.T) {
	columns := []Column{NewColumn("ID", "NUMBER"), NewColumn("NAME", "VARCHAR2")}
	got := Select("oracle", "OWNER", "PERMITS", columns)
	if !strings.Contains(got, `TO_CHAR("ID", 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')`) || !strings.Contains(got, `, "NAME" FROM "OWNER"."PERMITS"`) {
		t.Fatal(got)
	}
	pg := Select("postgres", "public", "permits", []Column{NewColumn("id", "NUMERIC")})
	if strings.Contains(pg, "TO_CHAR") || !strings.Contains(pg, `SELECT "id" FROM "public"."permits"`) {
		t.Fatal(pg)
	}
}

func TestTextReadsTheSameOnEveryRun(t *testing.T) {
	warsaw := time.FixedZone("CET", 3600)
	at := time.Date(2026, 11, 9, 1, 40, 25, 553520000, warsaw)
	day := time.Date(2026, 3, 14, 0, 0, 0, 0, time.UTC)
	tenth, fifth := 0.1, 0.2
	guid := []byte{0x78, 0x56, 0x34, 0x12, 0x34, 0x12, 0x34, 0x12, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0}
	cases := []struct {
		name string
		v    any
		c    Column
		want string
	}{
		{"whole number", int64(42), NewColumn("n", "INT8"), "42"},
		{"float", tenth + fifth, NewColumn("f", "FLOAT8"), "0.30000000000000004"},
		{"float 32", float32(1.5), NewColumn("f", "FLOAT4"), "1.5"},
		{"true", true, NewColumn("b", "BOOL"), "true"},
		{"numeric text", "12345678901234567890.12", NewColumn("d", "NUMERIC"), "12345678901234567890.12"},
		{"mysql decimal", []byte("150.00"), NewColumn("d", "DECIMAL"), "150.00"},
		{"sql server money", []byte("150.0000"), NewColumn("m", "MONEY"), "150.0000"},
		{"json bytes", []byte(`{"a": 1}`), NewColumn("j", "JSONB"), `{"a": 1}`},
		{"a date", day, NewColumn("d", "DATE"), "2026-03-14"},
		{"an oracle date with a time", at, NewColumn("d", "DATE"), "2026-11-09 01:40:25.55352"},
		{"a moment with a zone reads in UTC", at, NewColumn("t", "TIMESTAMPTZ"), "2026-11-09T00:40:25.55352Z"},
		{"datetimeoffset", at, NewColumn("t", "DATETIMEOFFSET"), "2026-11-09T00:40:25.55352Z"},
		{"a moment with no zone", time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), NewColumn("t", "TIMESTAMP"), "2026-01-02 03:04:05"},
		{"short binary", []byte{0xde, 0xad}, NewColumn("b", "BYTEA"), `\xdead`},
		{"sql server guid", guid, NewColumn("g", "UNIQUEIDENTIFIER"), "12345678-1234-1234-1234-56789ABCDEF0"},
		{"bad text", "a\xffb", NewColumn("t", "TEXT"), "a�b"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Text(c.v, c.c)
			if got == nil || *got != c.want {
				t.Fatalf("got %v, want %q", deref(got), c.want)
			}
		})
	}
	if Text(nil, NewColumn("x", "TEXT")) != nil {
		t.Fatal("NULL is nil")
	}
	long := make([]byte, BinaryHexMax+1)
	got := *Text(long, NewColumn("b", "VARBINARY"))
	if !strings.HasPrefix(got, "[binary, 1025 bytes, sha256 ") {
		t.Fatal(got)
	}
	long[0] = 1
	if *Text(long, NewColumn("b", "VARBINARY")) == got {
		t.Fatal("a change in a long binary value must change its text")
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

// The cases are shared with the caller's own check of the same rule, so the two cannot drift.
func TestQueryRefusal(t *testing.T) {
	data, err := os.ReadFile("../../contract/vectors/query-refusal.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		WriteWords []string `json:"writeWords"`
		Cases      []struct {
			SQL     string `json:"sql"`
			Refused bool   `json:"refused"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) < 10 {
		t.Fatalf("only %d cases", len(file.Cases))
	}
	if !slices.Equal(file.WriteWords, WriteWords) {
		t.Fatalf("the file names %v, the runner %v", file.WriteWords, WriteWords)
	}
	for _, word := range WriteWords {
		if QueryRefusal("SELECT a "+word+" b FROM t") == "" {
			t.Errorf("%s is not refused", word)
		}
	}
	for _, c := range file.Cases {
		if why := QueryRefusal(c.SQL); (why != "") != c.Refused {
			t.Errorf("%q: refused %q, want refused %t", c.SQL, why, c.Refused)
		}
	}
}

func TestDriverTypesOfBinaryValuesKeepTheirBytes(t *testing.T) {
	for _, base := range []string{"LONGRAW", "OCIBLOBLOCATOR", "GEOGRAPHY", "HIERARCHYID"} {
		a, b := Text([]byte{0xff, 'x'}, NewColumn("b", base)), Text([]byte{0xfe, 'x'}, NewColumn("b", base))
		if *a == *b {
			t.Errorf("%s: two different values read the same: %q", base, *a)
		}
		if !strings.HasPrefix(*a, `\x`) {
			t.Errorf("%s: %q is not binary's form", base, *a)
		}
	}
}

func TestA32BitFloatKeepsItsShortestDigits(t *testing.T) {
	widened := float64(float32(19.99))
	for _, base := range []string{"FLOAT4", "REAL"} {
		if got := *Text(widened, NewColumn("f", base)); got != "19.99" {
			t.Errorf("%s: %s", base, got)
		}
	}
	if got := *Text(widened, NewColumn("f", "FLOAT8")); got != "19.989999771118164" {
		t.Errorf("a 64-bit float keeps every digit it has: %s", got)
	}
}
