package engine

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"

	"github.com/sijms/go-ora/v2/converters"
)

// A statement that passes the check of its text and holds a character outside ASCII in a string.
const accented = "SELECT id FROM permits WHERE applicant = 'Zoë'"

func named(tag, name string) map[string]answer {
	return map[string]answer{tag: {cols: []string{"VALUE"}, rows: [][]driver.Value{{name}}}}
}

// A statement of ASCII characters alone is read as written everywhere: it asks nothing. The fake
// fails the test on a question it was not given an answer for.
func TestAStatementOfASCIIAloneAsksNoCharacterSet(t *testing.T) {
	for _, engineName := range fourEngines {
		t.Run(engineName, func(t *testing.T) {
			db, f := newFake(t, map[string]answer{})
			why, err := CharacterSetRefusal(context.Background(), db, engineName, "SELECT id FROM permits WHERE applicant = 'Zoe'")
			if why != "" || err != nil || len(f.asked) != 0 {
				t.Fatalf("refusal %q, error %v, asked %v", why, err, f.asked)
			}
		})
	}
}

// SQL Server and PostgreSQL read a character outside ASCII as it is written: nothing to ask.
func TestEnginesThatReadEveryCharacterAsWrittenAreNotAsked(t *testing.T) {
	for _, engineName := range []string{"sqlserver", "postgres"} {
		t.Run(engineName, func(t *testing.T) {
			db, f := newFake(t, map[string]answer{})
			why, err := CharacterSetRefusal(context.Background(), db, engineName, accented)
			if why != "" || err != nil || len(f.asked) != 0 {
				t.Fatalf("refusal %q, error %v, asked %v", why, err, f.asked)
			}
		})
	}
}

func TestAStatementWithACharacterOutsideASCIIRunsOnlyOnAUnicodeSession(t *testing.T) {
	cases := []struct {
		engineName, tag, charset string
		runs                     bool
	}{
		{"oracle", "charset:database", "AL32UTF8", true},
		{"oracle", "charset:database", "UTF8", true},
		{"oracle", "charset:database", "al32utf8", true},
		{"oracle", "charset:database", "WE8MSWIN1252", false},
		{"oracle", "charset:database", "WE8ISO8859P1", false},
		{"oracle", "charset:database", "US7ASCII", false},
		{"mysql", "charset:client", "utf8mb4", true},
		{"mysql", "charset:client", "utf8mb3", true},
		{"mysql", "charset:client", "utf8", true},
		{"mysql", "charset:client", "gbk", false},
		{"mysql", "charset:client", "latin1", false},
	}
	for _, c := range cases {
		t.Run(c.engineName+" "+c.charset, func(t *testing.T) {
			db, f := newFake(t, named(c.tag, c.charset))
			why, err := CharacterSetRefusal(context.Background(), db, c.engineName, accented)
			if err != nil {
				t.Fatal(err)
			}
			if _, asked := f.asked[c.tag]; !asked {
				t.Fatalf("the database was not asked: %v", f.asked)
			}
			// The question itself is ASCII, so it is read as written whatever the answer is.
			if !ascii(f.said[c.tag]) {
				t.Fatalf("the question holds a character outside ASCII: %q", f.said[c.tag])
			}
			if c.runs {
				if why != "" {
					t.Fatalf("refused: %q", why)
				}
				return
			}
			if !strings.HasPrefix(why, "A query for this ") || !strings.Contains(why, c.charset) || !strings.Contains(why, "holds only ASCII characters") {
				t.Fatalf("refusal %q", why)
			}
		})
	}
}

// A refusal says how to write the character, and the check of a statement takes what it says.
func TestTheRefusalSaysHowToWriteTheCharacter(t *testing.T) {
	for engineName, way := range map[string]string{
		"oracle": `UNISTR('Jos\00e9')`,
		"mysql":  "CHAR(0xC3A9 USING utf8mb4)",
	} {
		why := charsetRefusal(engineName, "X")
		if !strings.Contains(why, way) {
			t.Errorf("%s: %q does not say %s", engineName, why, way)
		}
		statement := "SELECT id FROM permits WHERE applicant = " + way
		if !ascii(statement) || QueryRefusal(engineName, statement) != "" {
			t.Errorf("%s: %q is refused: %q", engineName, statement, QueryRefusal(engineName, statement))
		}
	}
}

// When the database cannot be asked, or names nothing, nothing is known: the statement does not
// run, and the error is the question's own.
func TestAQuestionThatFailsIsAnError(t *testing.T) {
	t.Run("the question fails", func(t *testing.T) {
		db, _ := newFake(t, map[string]answer{"charset:database": {err: errors.New("ORA-00942: table or view does not exist")}})
		why, err := CharacterSetRefusal(context.Background(), db, "oracle", accented)
		if why != "" || err == nil || !strings.Contains(err.Error(), "ORA-00942") {
			t.Fatalf("refusal %q, error %v", why, err)
		}
	})
	t.Run("no row", func(t *testing.T) {
		db, _ := newFake(t, map[string]answer{"charset:client": {cols: []string{"VALUE"}}})
		if why, err := CharacterSetRefusal(context.Background(), db, "mysql", accented); why != "" || err == nil {
			t.Fatalf("refusal %q, error %v", why, err)
		}
	})
	t.Run("an empty name", func(t *testing.T) {
		db, _ := newFake(t, map[string]answer{"charset:client": {cols: []string{"VALUE"}, rows: [][]driver.Value{{nil}}}})
		if why, err := CharacterSetRefusal(context.Background(), db, "mysql", accented); why != "" || err == nil {
			t.Fatalf("refusal %q, error %v", why, err)
		}
	})
}

// The name goes into a sentence a person reads, so it is kept to a name's characters and length.
func TestACharacterSetsNameIsKeptToAName(t *testing.T) {
	for answer, want := range map[string]string{
		" WE8MSWIN1252\n":        "WE8MSWIN1252",
		"gb'k\"; -- <b>":         "gbkb",
		"é＇":                     "",
		strings.Repeat("A", 100): strings.Repeat("A", 40),
		"utf8mb4_0900_ai_ci":     "utf8mb4_0900_ai_ci",
		"Łatin1":                 "atin1",
		"WE8ʼMSWIN1252":          "WE8MSWIN1252",
	} {
		if got := charsetName(answer); got != want {
			t.Errorf("%q: %q, want %q", answer, got, want)
		}
	}
	db, _ := newFake(t, named("charset:client", "gb'k"))
	why, err := CharacterSetRefusal(context.Background(), db, "mysql", accented)
	if err != nil || !strings.Contains(why, " as gbk, ") || strings.Contains(why, "'k") {
		t.Fatalf("refusal %q, error %v", why, err)
	}
}

// What the check rests on, held to the Oracle driver's own tables. For AL32UTF8 (873) and UTF8
// (871) the driver sends a statement's text as it is. For another set it rewrites characters, and
// some become the ASCII characters that end quoted text or a comment: here WE8MSWIN1252 (178). A
// driver that changes either fact fails this test, and the check is read again.
func TestTheOracleDriverRewritesAStatementForADatabaseThatIsNotUnicode(t *testing.T) {
	text := "SELECT 'ʼ ＇ ＂ ＊／ Zoë 名前' FROM dual"
	for _, id := range []int{873, 871} {
		conv := converters.NewStringConverter(id)
		if conv == nil {
			t.Fatalf("the driver has no converter for character set %d", id)
		}
		if got := string(conv.Encode(text)); got != text {
			t.Errorf("character set %d: the driver sends %q for %q", id, got, text)
		}
	}
	windows := converters.NewStringConverter(178)
	if windows == nil {
		t.Fatal("the driver has no converter for character set 178")
	}
	for written, sent := range map[string]string{
		"ʼ":        "'",
		"＇":        "'",
		"＂":        `"`,
		"＊／":       "*/",
		"SELECT 1": "SELECT 1",
	} {
		if got := string(windows.Encode(written)); got != sent {
			t.Errorf("WE8MSWIN1252: the driver sends %q for %q, and this test expects %q", got, written, sent)
		}
	}
	// So a string that holds such a character ends earlier for the database than for the check.
	statement := "SELECT id FROM permits WHERE applicant = 'aʼ OR 1 = 1 --'"
	if QueryRefusal("oracle", statement) != "" {
		t.Fatalf("the check of the text refuses %q: this test needs a statement it takes", statement)
	}
	if got, want := string(windows.Encode(statement)), "SELECT id FROM permits WHERE applicant = 'a' OR 1 = 1 --'"; got != want {
		t.Errorf("WE8MSWIN1252: the driver sends %q, and this test expects %q", got, want)
	}
}
