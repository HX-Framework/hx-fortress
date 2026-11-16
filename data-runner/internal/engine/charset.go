package engine

// Which characters a database reads when a query's statement holds one outside ASCII.
//
// The check of a query's statement (readonly.go) reads the text as it is written, and it takes a
// character outside ASCII inside quoted text and inside a comment. That is right only when the
// database reads the same character there. On two engines it can read another one, depending on a
// setting the text does not show:
//
//   - Oracle. The driver writes a statement in the database's own character set. For AL32UTF8 and
//     UTF8 it sends the text as it is. For any other set it rewrites each character with a table,
//     and the tables write some characters as an ASCII character that looks like them: in
//     WE8MSWIN1252, the modifier apostrophe (U+02BC) and the fullwidth apostrophe (U+FF07) are
//     written as ', and the fullwidth asterisk and solidus as * and /. Quoted text, or a comment,
//     would end earlier for Oracle than for the check, and Oracle would read what follows as SQL.
//   - MySQL. The server reads a statement in the session's character_set_client. The driver asks
//     for utf8mb4, and a server can be set to ignore what a client asks for. Read in a two-byte
//     character set, the last byte of a character outside ASCII can take the backtick after it as
//     its second byte, so a quoted name would end later for MySQL than for the check.
//
// SQL Server takes a statement as UTF-16 and reads it so. PostgreSQL refuses a character its
// encoding does not hold, and reads no byte of a character outside ASCII as an ASCII character.
//
// So a statement that holds a character outside ASCII first asks its database which character set
// it reads a statement in, and runs only when that is Unicode. A statement of ASCII characters
// alone is read as written everywhere, and asks nothing.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// charsetQuestion is how one engine is asked which character set a session reads a statement in,
// and the answers that are Unicode: with them, a character outside ASCII arrives as it is written.
type charsetQuestion struct {
	statement string
	unicode   []string
}

// charsetQuestions holds the engines that can read another character than the one written. The
// two the driver sends as they are, on Oracle, are the ones its own code names (the test holds the
// driver to that).
var charsetQuestions = map[string]charsetQuestion{
	"oracle": {
		statement: "SELECT VALUE FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER = 'NLS_CHARACTERSET' /* charset:database */",
		unicode:   []string{"AL32UTF8", "UTF8"},
	},
	"mysql": {
		statement: "SELECT @@character_set_client /* charset:client */",
		unicode:   []string{"utf8mb4", "utf8mb3", "utf8"},
	},
}

// CharacterSetRefusal says why a query's statement does not run on this session as it is written,
// or "" when it does: its database reads every character of it as written. It asks the database
// only for a statement that holds a character outside ASCII, on an engine that can read another
// character in its place. An error is the question's own failure: nothing is known then, and the
// statement does not run.
func CharacterSetRefusal(ctx context.Context, q Querier, engineName, statement string) (string, error) {
	question, asks := charsetQuestions[engineName]
	if !asks || ascii(statement) {
		return "", nil
	}
	var answer sql.NullString
	if err := q.QueryRowContext(ctx, question.statement).Scan(&answer); err != nil {
		return "", err
	}
	// The answer itself decides, whole: only a name of the list is Unicode. The name that goes
	// into a sentence is cleaned (charsetName), and what is left of another answer after cleaning
	// could spell a name of the list.
	said := strings.TrimSpace(answer.String)
	for _, unicode := range question.unicode {
		if strings.EqualFold(said, unicode) {
			return "", nil
		}
	}
	name := charsetName(said)
	if name == "" {
		return "", errors.New("the database named no character set")
	}
	return charsetRefusal(engineName, name), nil
}

// charsetName is a character set's name as a database answered it, kept to the characters such a
// name has and to a name's length: it goes into a sentence a person reads.
func charsetName(answer string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(answer) {
		if b.Len() == 40 {
			break
		}
		if r < 0x80 && (isLetter(byte(r)) || isDigit(byte(r)) || r == '_') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// charsetRefusal is the sentence for a statement that holds a character outside ASCII on a session
// that reads the named character set. It says how to write such a character, in a way the check of
// the statement takes.
func charsetRefusal(engineName, charset string) string {
	if engineName == "oracle" {
		return fmt.Sprintf("A query for this database holds only ASCII characters: the database keeps its text in %s, and a character outside ASCII would be rewritten to fit that before the database reads the query. Write such a character with UNISTR, as in UNISTR('Jos\\00e9').", charset)
	}
	return fmt.Sprintf("A query for this server holds only ASCII characters: the server reads a statement as %s, not as UTF-8, so it would read a character outside ASCII as other characters. Write such a character with CHAR, as in CHAR(0xC3A9 USING utf8mb4).", charset)
}
