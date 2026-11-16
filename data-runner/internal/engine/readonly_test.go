package engine

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

// refusalCases are the shared cases of the read-only rule: the runner's caller reads the same
// file, so the two cannot drift.
type refusalCases struct {
	WriteWords  []string            `json:"writeWords"`
	EngineWords map[string][]string `json:"engineWords"`
	// Cases hold on every engine.
	Cases []refusalCase `json:"cases"`
	// EngineCases hold on the engines they name.
	EngineCases []refusalCase `json:"engineCases"`
	// Sentences are what the rule says, word for word, for one case of each kind.
	Sentences []struct {
		Engine string `json:"engine"`
		SQL    string `json:"sql"`
		Says   string `json:"says"`
	} `json:"sentences"`
}

type refusalCase struct {
	Engines []string `json:"engines"`
	SQL     string   `json:"sql"`
	Refused bool     `json:"refused"`
	Why     string   `json:"why"`
}

func readRefusalCases(t *testing.T) refusalCases {
	t.Helper()
	data, err := os.ReadFile("../../contract/vectors/query-refusal.json")
	if err != nil {
		t.Fatal(err)
	}
	var file refusalCases
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	return file
}

var fourEngines = []string{"sqlserver", "oracle", "mysql", "postgres"}

// Every shared case is refused or taken as the file says, and refused for the reason it says.
func TestQueryRefusalReadsTheSharedCases(t *testing.T) {
	file := readRefusalCases(t)
	if len(file.Cases) < 50 || len(file.EngineCases) < 50 {
		t.Fatalf("only %d cases on every engine and %d on some", len(file.Cases), len(file.EngineCases))
	}
	if !slices.Equal(file.WriteWords, WriteWords) {
		t.Fatalf("the file names %v, the runner %v", file.WriteWords, WriteWords)
	}
	if len(file.EngineWords) != len(EngineWords) {
		t.Fatalf("the file names words for %d engines, the runner for %d", len(file.EngineWords), len(EngineWords))
	}
	for _, engineName := range fourEngines {
		if !slices.Equal(file.EngineWords[engineName], EngineWords[engineName]) {
			t.Fatalf("%s: the file names %v, the runner %v", engineName, file.EngineWords[engineName], EngineWords[engineName])
		}
	}
	check := func(c refusalCase, engines []string) {
		if c.Refused == (c.Why == "") {
			t.Errorf("%q: a refused case says why, and a taken one does not", c.SQL)
			return
		}
		for _, engineName := range engines {
			got := queryRefusal(engineName, c.SQL)
			code := ""
			if got != nil {
				code = got.code
				if got.words == "" || !strings.HasPrefix(got.words, "A ") && !strings.HasPrefix(got.words, "On ") && !strings.HasPrefix(got.words, "Outside ") {
					t.Errorf("%s %q: a refusal is a sentence, and this one says %q", engineName, c.SQL, got.words)
				}
			}
			if code != c.Why {
				t.Errorf("%s %q: refused as %q, want %q", engineName, c.SQL, code, c.Why)
			}
			if (QueryRefusal(engineName, c.SQL) != "") != c.Refused {
				t.Errorf("%s %q: QueryRefusal does not answer what the case says", engineName, c.SQL)
			}
		}
	}
	for _, c := range file.Cases {
		if len(c.Engines) != 0 {
			t.Errorf("%q: a case that holds on every engine names none", c.SQL)
		}
		check(c, fourEngines)
	}
	// A statement of engineCases names each of the four engines once, across its cases.
	named := map[string][]string{}
	for _, c := range file.EngineCases {
		if len(c.Engines) == 0 || len(c.Engines) == len(fourEngines) {
			t.Errorf("%q: a case of some engines names one to three of them", c.SQL)
		}
		named[c.SQL] = append(named[c.SQL], c.Engines...)
		check(c, c.Engines)
	}
	for sql, engines := range named {
		slices.Sort(engines)
		if want := slices.Sorted(slices.Values(fourEngines)); !slices.Equal(engines, want) {
			t.Errorf("%q: its cases name %v, want each engine once", sql, engines)
		}
	}
}

// Every word that writes is refused as a word of its own, in any case, on the engines that hold
// it. Quoted, it is a name; inside a longer word, it is another word.
func TestQueryRefusalRefusesEveryWordThatWrites(t *testing.T) {
	for _, engineName := range fourEngines {
		for _, word := range slices.Concat(WriteWords, EngineWords[engineName]) {
			for _, sql := range []string{"SELECT a " + word + " b FROM t", "select 1 " + strings.ToLower(word) + " permits"} {
				if got := queryRefusal(engineName, sql); got == nil || got.code != refusedWrites || !strings.Contains(got.words, word) {
					t.Errorf("%s %q: %+v, want it refused for %s", engineName, sql, got, word)
				}
			}
			for _, sql := range []string{`SELECT "` + word + `" FROM permits`, "SELECT " + word + "_count, last_" + word + " FROM permits"} {
				if got := queryRefusal(engineName, sql); got != nil {
					t.Errorf("%s %q: refused as %s", engineName, sql, got.code)
				}
			}
		}
	}
	// A word one engine reserves is a column's name on another.
	for _, word := range EngineWords["sqlserver"] {
		if got := queryRefusal("postgres", "SELECT "+word+" FROM prices"); got != nil {
			t.Errorf("postgres: %s is refused as %s, and only SQL Server reserves it", word, got.code)
		}
	}
}

// On MySQL a bracket outside quotes is refused: a MariaDB server in MSSQL mode reads [name] as a
// quoted name. So is a $ that starts a word: MySQL 8.1 and later read $$ and $tag$ there as the
// start of quoted text. Inside quoted text, a comment or a name, each is only a character.
func TestQueryRefusalOnMySQLRefusesABracketAndADollarSignThatStartsAWord(t *testing.T) {
	for _, sql := range []string{
		"SELECT [Permit No] FROM permits",
		"SELECT 1 AS [a'] INTO OUTFILE '/tmp/permits' -- '",
		"SELECT $$'$$ FROM permits",
		"SELECT $js$'$js$ FROM permits",
		"SELECT $total FROM permits",
		"SELECT p.$total FROM permits p",
	} {
		if got := queryRefusal("mysql", sql); got == nil || got.code != refusedOtherQuoting {
			t.Errorf("%q: %+v, want it refused as %s", sql, got, refusedOtherQuoting)
		}
	}
	for _, sql := range []string{
		"SELECT permit_no FROM permits WHERE note = '[draft]' AND mark = '$$'",
		"SELECT permit_no /* [draft] $$ */ FROM permits",
		"SELECT sid, `$total`, total$, a$$b, 1$ FROM v$session",
	} {
		if got := queryRefusal("mysql", sql); got != nil {
			t.Errorf("%q: refused as %s, want it taken", sql, got.code)
		}
	}
}

// On PostgreSQL an at sign is an operator, and on Oracle it starts a database link's name, so a
// word ends there and the word after it is read by itself. On SQL Server it is part of a name, and
// on MySQL it starts a variable, whose name is no word that writes.
func TestQueryRefusalReadsTheWordAfterAnAtSignOnPostgreSQLAndOracle(t *testing.T) {
	for _, engineName := range []string{"postgres", "oracle"} {
		for _, sql := range []string{"SELECT a@delete FROM permits", "SELECT 1@INTO permits_copy FROM permits", "SELECT * FROM permits@update"} {
			if got := queryRefusal(engineName, sql); got == nil || got.code != refusedWrites {
				t.Errorf("%s %q: %+v, want it refused as %s", engineName, sql, got, refusedWrites)
			}
		}
		if got := queryRefusal(engineName, "SELECT * FROM permits@town_hall WHERE tags <@ other_tags"); got != nil {
			t.Errorf("%s: a database link and an operator are refused as %s", engineName, got.code)
		}
	}
	for _, engineName := range []string{"sqlserver", "mysql"} {
		if got := queryRefusal(engineName, "SELECT a@delete, @update FROM permits"); got != nil {
			t.Errorf("%s: a name that holds an at sign, or a variable, is refused as %s", engineName, got.code)
		}
	}
}

// A sentence says what is wrong and what to write instead, and names what it found. The shared
// file holds one of each kind, word for word, so the runner and its caller say the same.
func TestQueryRefusalSaysTheSharedSentences(t *testing.T) {
	file := readRefusalCases(t)
	if len(file.Sentences) < 15 {
		t.Fatalf("only %d sentences", len(file.Sentences))
	}
	said := map[string]bool{}
	for _, c := range file.Sentences {
		if got := QueryRefusal(c.Engine, c.SQL); got != c.Says {
			t.Errorf("%s %q says %q, want %q", c.Engine, c.SQL, got, c.Says)
		}
		said[c.Says] = true
	}
	if len(said) != len(file.Sentences) {
		t.Errorf("%d sentences, %d of them different: each is of another kind", len(file.Sentences), len(said))
	}
}

// A job's engine is one of four. job.Validate refuses any other, and so does this.
func TestQueryRefusalTakesNoStatementForAnotherEngine(t *testing.T) {
	for _, engineName := range []string{"", "db2", "SQLSERVER", "sqlite"} {
		if got := queryRefusal(engineName, "SELECT 1"); got == nil || got.code != refusedEngine {
			t.Errorf("%q: %+v", engineName, got)
		}
	}
}
