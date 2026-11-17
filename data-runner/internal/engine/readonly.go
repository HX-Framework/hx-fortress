package engine

// The check of a query's statement, made before anything runs it: is it one statement, and does
// its text say that it only reads?
//
// WHAT KEEPS A QUERY FROM CHANGING A DATABASE is not this file. It is the connection's read login,
// and the transaction the statement runs in: read-only on PostgreSQL, MySQL and Oracle, and rolled
// back on every engine. SQL Server has no read-only transaction, so there this check and the login
// are the line.
//
// THE RULE. Take the quoted text and the comments out of the statement. What is left starts with
// SELECT or WITH, is one statement, and holds none of WriteWords and none of its engine's
// EngineWords as a word of its own. A column that has such a name is written in quotes, and then it
// is not looked at.
//
// EACH ENGINE IS READ ITS OWN WAY, because the engines do not agree on what is a quote:
//
//   - [name] is a quoted name on SQL Server, where ]] is a ] inside it. On Oracle and PostgreSQL
//     a bracket is an ordinary character. MySQL is below.
//   - $$text$$ and $tag$text$tag$ are quoted text on PostgreSQL only.
//   - A backtick quotes a name on MySQL only. Elsewhere it is refused.
//   - On SQL Server a second statement needs no semicolon ("SELECT 1 COMMIT DELETE FROM t"), so
//     the words that start one there are refused too. SQL Server reserves every one of them, so
//     none can be a column's name without quotes.
//   - An at sign is part of a name on SQL Server, and on MySQL it starts a variable. On
//     PostgreSQL it is an operator and on Oracle it starts a database link's name, so there a word
//     ends at it and the word after it is read by itself.
//
// WHAT TWO ENGINES COULD READ DIFFERENTLY IS REFUSED, NEVER GUESSED AT:
//
//   - # outside quotes: a comment on MySQL, an operator or part of a name elsewhere
//   - -- with no space after it: MySQL reads two minus signs
//   - a backslash before a quote inside quoted text: some engines escape the quote, the others
//     end the text
//   - /*! ... */: a comment MySQL runs
//   - a /* inside a comment: some engines nest comments, the others do not
//   - Oracle's q'[...]' and SQL Server's {call ...}
//   - a control character other than a tab or a line end, and a carriage return that no line feed
//     follows: some engines end a -- comment there and some do not
//   - a letter outside a to z that stands outside quotes: the engines do not agree on which of
//     them are part of a name
//   - on PostgreSQL, a $ that does not open quoted text: a parameter, part of a name, or quoted
//     text that touches a number. A query has no parameters
//   - on MySQL, a bracket outside quotes: MySQL reads it as no part of a statement, and MariaDB
//     reads [name] as a quoted name when its sql_mode holds MSSQL (MariaDB 10.4.5 and later)
//   - on MySQL, a $ that starts a word: MySQL 8.1 and later read $$ or $tag$ there as the start
//     of quoted text, which only a stored program's body may hold. Inside a name it is part of
//     the name, as in v$session. Right after a number with a decimal point or an exponent it
//     starts a word: MySQL ends such a number whatever follows (1.5$$ is 1.5 and then $$)
//   - a number that runs into a word that writes: 1e1DELETE is a number and then DELETE
//   - a number whose exponent has no digits (1.5e, 1.5e-): MySQL reads such a number with a point
//     as an error and the character after it as a token of its own, so after 1.5e- a second
//     minus sign is a minus sign there, and no -- comment starts
//   - a quote, a bracket or a comment that is never closed
//
// WHICH CHARACTERS THE DATABASE READS is a second question, asked of the database itself
// (charset.go). This check takes a character outside ASCII inside quoted text and comments, and on
// Oracle and MySQL the database can read another character in its place. A query job asks before
// it runs such a statement.
//
// WHAT A CHECK OF THE TEXT CANNOT SEE. A function that does more than read: one that takes the
// next number of a sequence, sleeps, or calls out of the database. On SQL Server, a second SELECT,
// and a second statement that starts with a word SQL Server does not reserve, or with END or
// FETCH, which SQL Server reserves and a SELECT uses itself (CASE ... END, OFFSET ... FETCH). A
// statement that holds a lock for as long as it runs: a table hint on SQL Server, or FOR SHARE on
// MySQL. Each of these is bounded by what the login may do and by the job's deadline.
//
// The runner's caller makes the same check before it starts a job. The file
// contract/vectors/query-refusal.json holds the cases both read, each with the code it is refused
// with, so the two cannot drift.

import (
	"fmt"
	"strings"
)

// WriteWords are the words that change a database, or reach outside it, on every engine. A
// statement that holds one outside quotes and comments does not run. INTO is here because SELECT
// INTO writes a table or a file.
var WriteWords = []string{
	"INTO", "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "REVOKE", "DENY",
	"EXEC", "EXECUTE", "COMMIT", "ROLLBACK", "BACKUP", "RESTORE", "DBCC", "KILL", "SHUTDOWN", "RECONFIGURE",
	"OPENROWSET", "OPENDATASOURCE", "OPENQUERY",
}

// EngineWords are the words that start a statement of their own on one engine and are no part of
// a SELECT there. The engine reserves each, so a column cannot have one of these names without
// quotes. MySQL's LOCK IN SHARE MODE holds rows locked for as long as its transaction lasts.
var EngineWords = map[string][]string{
	"sqlserver": {
		"DECLARE", "SET", "USE", "TRAN", "TRANSACTION", "TRIGGER", "ADD", "BREAK", "CONTINUE", "DUMP", "LOAD",
		"WAITFOR", "WRITETEXT", "UPDATETEXT", "READTEXT", "CHECKPOINT", "REVERT", "SETUSER", "OPEN", "CLOSE",
		"DEALLOCATE", "BEGIN", "WHILE", "IF", "GOTO", "RETURN", "PRINT", "RAISERROR", "SAVE", "BULK",
	},
	"oracle":   {},
	"mysql":    {"LOCK"},
	"postgres": {},
}

// engineLabels are the engines a query runs on, as a sentence names them.
var engineLabels = map[string]string{
	"sqlserver": "SQL Server",
	"oracle":    "Oracle",
	"mysql":     "MySQL",
	"postgres":  "PostgreSQL",
}

// The codes a statement is refused with. The shared cases name each case's code, so the runner
// and its caller refuse a statement for the same reason, not only both refuse it.
const (
	refusedEmpty             = "empty"
	refusedNotASelect        = "not_a_select"
	refusedSeveralStatements = "several_statements"
	refusedWrites            = "writes"
	refusedNotClosed         = "not_closed"
	refusedBackslashQuote    = "backslash_quote"
	refusedDashes            = "dashes_without_space"
	refusedHash              = "hash_sign"
	refusedCommentThatRuns   = "comment_that_runs"
	refusedNestedComment     = "nested_comment"
	refusedControlCharacter  = "control_character"
	refusedUnquotedLetter    = "unquoted_letter"
	refusedOtherQuoting      = "other_quoting"
	// refusedEngine is a job whose engine is none of the four. job.Validate refuses such a job
	// first, so no case names this code.
	refusedEngine = "engine"
)

// A refusal is why a statement is not taken: its code, and the sentence a person reads.
type refusal struct {
	code  string
	words string
}

func refuse(code, format string, args ...any) *refusal {
	return &refusal{code: code, words: fmt.Sprintf(format, args...)}
}

// QueryRefusal says why a query's SQL is not one statement that only reads on its engine, or ""
// when it is. The engine is the job's: "sqlserver", "oracle", "mysql" or "postgres".
func QueryRefusal(engineName, sql string) string {
	if r := queryRefusal(engineName, sql); r != nil {
		return r.words
	}
	return ""
}

func queryRefusal(engineName, sql string) *refusal {
	label, known := engineLabels[engineName]
	if !known {
		return refuse(refusedEngine, "A query runs on SQL Server, Oracle, MySQL or PostgreSQL, and this job names %q.", engineName)
	}
	if hasControlCharacter(sql) {
		return refuse(refusedControlCharacter, "A query holds no control character but a tab and a line end, and a line feed follows each carriage return.")
	}
	bare, refused := bareStatement(engineName, label, sql)
	if refused != nil {
		return refused
	}
	text := strings.ToUpper(strings.TrimSpace(bare))
	if text == "" {
		return refuse(refusedEmpty, "A query needs a SELECT statement.")
	}
	words, refused := statementWords(text, engineName)
	if refused != nil {
		return refused
	}
	if len(words) == 0 || (words[0] != "SELECT" && words[0] != "WITH") || !strings.HasPrefix(text, words[0]) {
		return refuse(refusedNotASelect, "A query reads: it starts with SELECT or WITH.")
	}
	if semicolon := strings.IndexByte(text, ';'); semicolon >= 0 && strings.TrimSpace(text[semicolon+1:]) != "" {
		return refuse(refusedSeveralStatements, "A query is one statement.")
	}
	for _, word := range words {
		if refused := wordRefusal(word, engineName, label); refused != nil {
			return refused
		}
	}
	return nil
}

// wordRefusal is why a word of a statement keeps it from running, or nil when it does not.
func wordRefusal(word, engineName, label string) *refusal {
	if word == "INTO" {
		return refuse(refusedWrites, "A query reads: SELECT INTO writes, so it does not run.")
	}
	if holds(WriteWords, word) {
		return refuse(refusedWrites, "A query reads: %s changes the database, so it does not run. A column of that name is quoted.", word)
	}
	if holds(EngineWords[engineName], word) {
		return refuse(refusedWrites, "A query reads: on %s, %s is no part of a statement that only reads, so it does not run. A column of that name is quoted.", label, word)
	}
	return nil
}

func holds(words []string, word string) bool {
	for _, w := range words {
		if w == word {
			return true
		}
	}
	return false
}

// hasControlCharacter says whether the text holds a character no statement needs and no two
// engines are known to read alike.
func hasControlCharacter(sql string) bool {
	for at, r := range sql {
		switch {
		case r == '\t' || r == '\n':
		case r == '\r':
			// A carriage return alone ends a -- comment on some engines and not on others. One
			// that a line feed follows is a line end everywhere.
			if at+1 >= len(sql) || sql[at+1] != '\n' {
				return true
			}
		case r < 0x20 || r == 0x7f || r == 0x85 || r == 0x2028 || r == 0x2029:
			return true
		}
	}
	return false
}

// quotedMark stands in the bare statement where quoted text was. It is not a space, so that a
// statement which begins with quoted text does not begin with SELECT: SQL Server runs a procedure
// named at the start of a batch with no EXEC before it.
const quotedMark = '"'

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\r' || c == '\n' }
func isDigit(c byte) bool { return c >= '0' && c <= '9' }
func isLetter(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

// inName says whether a character is one a name may hold on some engine. An at sign is one only
// where atInName says so.
func inName(c byte, at bool) bool {
	return isLetter(c) || isDigit(c) || c == '_' || c == '$' || c == '#' || (at && c == '@')
}

func startsWord(c byte, at bool) bool {
	return isLetter(c) || c == '_' || c == '$' || c == '#' || (at && c == '@')
}

// atInName says whether a word goes on past an at sign on the engine. On SQL Server an at sign is
// part of a name, and on MySQL it starts a variable, whose name is no word that writes. PostgreSQL
// reads it as an operator and Oracle as the start of a database link's name, so there a word ends
// at it, and the word after it is read by itself.
func atInName(engineName string) bool {
	return engineName == "sqlserver" || engineName == "mysql"
}

// continuesName says whether a $ right after this character is part of the name it stands in, as
// in v$session, rather than the start of something.
func continuesName(before byte) bool {
	return isLetter(before) || isDigit(before) || before == '_' || before == '$'
}

// endsANumber says whether the $ at the index ends a number that has a decimal point or an
// exponent, as MySQL reads it. MySQL ends such a number whatever follows, so 1.5$$ is 1.5 and then
// $$, while an integer runs on into a name: 1$$ is a name. The letters, digits, _ and $ right
// before the $ end such a number when they are digits or an exponent after a point (1.5, .5, 1.e5),
// digits with an exponent (1e5), or the digits of an exponent after its sign (1e+5). A name of
// that shape after a point or a sign (t.5$) is refused with them.
func endsANumber(sql string, at int) bool {
	start := at
	for start > 0 && continuesName(sql[start-1]) {
		start--
	}
	digits, exponent, whole := numberTail(sql[start:at])
	if !whole {
		return false
	}
	switch before := charAt(sql, start-1); {
	case before == '.':
		return true
	case exponent:
		return digits > 0
	case before == '+' || before == '-':
		sign := charAt(sql, start-2)
		return sign == 'e' || sign == 'E'
	}
	return false
}

// numberTail reads a run of letters and digits as the end of a number: how many digits it starts
// with, whether an exponent follows them (e or E, then digits), and whether that is the whole run.
// The run is never empty: the character before the $ is part of it.
func numberTail(run string) (digits int, exponent, whole bool) {
	for digits < len(run) && isDigit(run[digits]) {
		digits++
	}
	rest := run[digits:]
	if rest == "" {
		return digits, false, true
	}
	if (rest[0] != 'e' && rest[0] != 'E') || len(rest) == 1 {
		return digits, false, false
	}
	for i := 1; i < len(rest); i++ {
		if !isDigit(rest[i]) {
			return digits, false, false
		}
	}
	return digits, true, true
}

// charAt is the character at an index of the text, or 0 when the index is outside it. No statement
// that gets this far holds a 0: it is a control character.
func charAt(s string, i int) byte {
	if i < 0 || i >= len(s) {
		return 0
	}
	return s[i]
}

// bareStatement is the statement without its quoted text and its comments, as its engine reads
// them: quoted text becomes quotedMark and a comment one space. Or why the text is not taken.
func bareStatement(engineName, label, sql string) (string, *refusal) {
	notClosed := func() (string, *refusal) {
		return "", refuse(refusedNotClosed, "A query's quotes, brackets and comments are closed.")
	}
	var b strings.Builder
	for at := 0; at < len(sql); {
		c, next, before := sql[at], charAt(sql, at+1), charAt(sql, at-1)
		switch {
		case c == '\'' || c == '"' || c == '`':
			if c == '`' && engineName != "mysql" {
				return "", refuse(refusedOtherQuoting, "A backtick quotes a name on MySQL only. On %s, write the name in double quotes.", label)
			}
			if c == '\'' && engineName == "oracle" && (before == 'q' || before == 'Q') {
				// q'[...]' ends where its own bracket closes, not at the next quote. A quote
				// right after a q is refused whatever stands before the q: Oracle starts such
				// text after a number too (1q'[...]'), and no statement that reads has a quote
				// right after a name that ends in q.
				return "", refuse(refusedOtherQuoting, "A query writes text between plain quotes: Oracle's q'[...]' form is not taken.")
			}
			// Quoted text ends at the same quote. Two of them in a row is one quote inside it.
			end, closed := at+1, false
			for end < len(sql) {
				if sql[end] == '\\' && charAt(sql, end+1) == c {
					return "", refuse(refusedBackslashQuote, "A query writes a quote inside quoted text as two quotes, with no backslash before it.")
				}
				if sql[end] == c {
					if charAt(sql, end+1) == c {
						end += 2
						continue
					}
					closed = true
					break
				}
				end++
			}
			if !closed {
				return notClosed()
			}
			at = end + 1
			b.WriteByte(quotedMark)
		case c == '[' && engineName == "sqlserver":
			end, closed := at+1, false
			for end < len(sql) {
				if sql[end] == ']' {
					if charAt(sql, end+1) == ']' {
						end += 2
						continue
					}
					closed = true
					break
				}
				end++
			}
			if !closed {
				return notClosed()
			}
			at = end + 1
			b.WriteByte(quotedMark)
		case c == '[' && strings.IndexByte(sql[at:], ']') < 0:
			// On the other engines a bracket is no quote. One that is never closed is no
			// statement on any of them.
			return notClosed()
		case c == '[' && engineName == "mysql":
			// MySQL reads a bracket as no part of a statement. MariaDB, which a MySQL job also
			// reaches, reads [name] as a quoted name when its sql_mode holds MSSQL, so a quote
			// inside the brackets would be text for this check and part of a name for it.
			return "", refuse(refusedOtherQuoting, "On MySQL a query has no [ outside quotes: a MariaDB server in MSSQL mode reads [name] as a quoted name. Write the name in backticks.")
		case c == '$' && engineName == "mysql" && (!continuesName(before) || endsANumber(sql, at)):
			// MySQL 8.1 and later read a $ that starts a word as quoted text when another $ ends
			// its tag ($$...$$, $tag$...$tag$), and before 8.1 as the first character of a name.
			// A $ right after a number with a decimal point or an exponent starts a word there.
			// Only a stored program's body may hold such text, so a SELECT never needs it.
			return "", refuse(refusedOtherQuoting, "On MySQL a query has no $ at the start of a word, or right after a number with a decimal point or an exponent: MySQL 8.1 and later read $$ or $tag$ there as the start of quoted text. A name that starts with $ is written in backticks.")
		case c == '{' && engineName == "sqlserver":
			return "", refuse(refusedOtherQuoting, "A query has no { outside quotes: SQL Server reads {call ...} as a call.")
		case c == '$' && engineName == "postgres":
			// $$ or $tag$ opens quoted text, where it does not touch a name before it.
			// PostgreSQL reads any other $ by what stands around it: a parameter, part of a
			// name, or quoted text after a number. A query has no parameters, so any other $ is
			// not taken.
			tagEnd := at + 1
			for tagEnd < len(sql) && (isLetter(sql[tagEnd]) || isDigit(sql[tagEnd]) || sql[tagEnd] == '_') {
				tagEnd++
			}
			if continuesName(before) || charAt(sql, tagEnd) != '$' || isDigit(next) {
				return "", refuse(refusedOtherQuoting, "On PostgreSQL a $ outside quotes opens quoted text ($$...$$ or $tag$...$tag$), set apart from the word before it. A query has no parameters ($1).")
			}
			tag := sql[at : tagEnd+1]
			closeAt := strings.Index(sql[tagEnd+1:], tag)
			if closeAt < 0 {
				return notClosed()
			}
			at = tagEnd + 1 + closeAt + len(tag)
			b.WriteByte(quotedMark)
		case c == '#':
			return "", refuse(refusedHash, "A query has no # outside quotes: MySQL starts a comment there. A name that holds one is written in quotes.")
		case c == '-' && next == '-':
			if after := charAt(sql, at+2); after != 0 && !isSpace(after) {
				return "", refuse(refusedDashes, "A query's -- comment has a space after it.")
			}
			// The comment ends at its line's end. A carriage return here always has a line feed after
			// it (hasControlCharacter), so the comment ends at either.
			end := at + 2
			for end < len(sql) && sql[end] != '\n' && sql[end] != '\r' {
				end++
			}
			at = end
			b.WriteByte(' ')
		case c == '/' && next == '*':
			if lead := sql[at+2 : min(at+4, len(sql))]; strings.HasPrefix(lead, "!") || lead == "M!" || lead == "m!" {
				return "", refuse(refusedCommentThatRuns, "A query has no comment MySQL would run (/*! ... */).")
			}
			closeAt := strings.Index(sql[at+2:], "*/")
			if closeAt < 0 {
				return notClosed()
			}
			if again := strings.Index(sql[at+2:], "/*"); again >= 0 && again < closeAt {
				return "", refuse(refusedNestedComment, "A query has no /* inside a comment: some databases nest comments and some do not.")
			}
			at += 2 + closeAt + 2
			b.WriteByte(' ')
		default:
			if c > 0x7e {
				return "", refuse(refusedUnquotedLetter, "Outside quotes, a query holds only the letters a to z, digits and signs. A name with another letter is written in quotes.")
			}
			b.WriteByte(c)
			at++
		}
	}
	return b.String(), nil
}

// exponentHasDigits says whether each E of a number that stands right after its digits or its
// point has digits after it: in the number itself (1.5E3), or after the sign that follows the
// number (1.5E-3). The text is a bare statement, in upper case, and the number is text[at:end].
// MySQL reads a number with a point whose exponent has no digits (1.5E, 1.5E-) as an error, and
// the character after it as a token of its own: after 1.5E- a second minus sign is a minus sign,
// so the -- that every other reading takes for a comment is SQL there. The other engines are not
// known to read such a number alike, so it is refused on each. Hex digits (0X1E) are no exponent.
func exponentHasDigits(text string, at, end int) bool {
	number := text[at:end]
	if strings.HasPrefix(number, "0X") {
		return true
	}
	for i := 1; i < len(number); i++ {
		if number[i] != 'E' || !(isDigit(number[i-1]) || number[i-1] == '.') {
			continue
		}
		if i+1 < len(number) {
			if !isDigit(number[i+1]) {
				return false
			}
			continue
		}
		sign := charAt(text, end)
		if (sign != '+' && sign != '-') || !isDigit(charAt(text, end+1)) {
			return false
		}
	}
	return true
}

// statementWords are the words of a bare statement, which is in upper case. A number that runs
// into a word that writes is refused: an engine reads 1E1DELETE as a number and then DELETE. So
// is a number whose exponent has no digits (exponentHasDigits).
func statementWords(text, engineName string) ([]string, *refusal) {
	var words []string
	atSign := atInName(engineName)
	for at := 0; at < len(text); {
		c, next := text[at], charAt(text, at+1)
		switch {
		case isDigit(c) || ((c == '.' || c == '$') && isDigit(next)):
			end := at + 1
			for end < len(text) && (inName(text[end], atSign) || text[end] == '.') {
				end++
			}
			number := text[at:end]
			for _, list := range [][]string{WriteWords, EngineWords[engineName]} {
				for _, word := range list {
					if strings.Contains(number, word) {
						return nil, refuse(refusedWrites, "A query reads: the number %s holds %s, which a database can read as a number and then %s, so it does not run. Write the number another way.", number, word, word)
					}
				}
			}
			if !exponentHasDigits(text, at, end) {
				return nil, refuse(refusedOtherQuoting, "A query writes a number's exponent with its digits: %s has none after its e, and MySQL reads the character after such a number as a token of its own. Write the digits, or leave the e out.", number)
			}
			at = end
		case startsWord(c, atSign):
			end := at + 1
			for end < len(text) && inName(text[end], atSign) {
				end++
			}
			word := text[at:end]
			words = append(words, word)
			// MySQL reads INTO@x as INTO and a variable.
			if sign := strings.IndexByte(word, '@'); sign > 0 {
				words = append(words, word[:sign])
			}
			at = end
		default:
			at++
		}
	}
	return words, nil
}
