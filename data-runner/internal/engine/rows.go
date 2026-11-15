package engine

// Reading a table's rows, for a pull and a query: how each engine quotes a name, how it says a
// table's primary key, and every value a driver answers as text that reads the same on every run.
// A value that read differently from one night to the next would make its row look changed, so
// each kind of value has one form:
//
//	whole numbers      decimal digits
//	other numbers      the shortest digits that read back the same; a decimal type as the server
//	                   writes it (its own digits, trailing zeros kept)
//	true and false     "true", "false"
//	a date             2006-01-02
//	a time of day      15:04:05.999999999
//	a moment in a zone RFC 3339 in UTC, with as many fraction digits as it has
//	a moment, no zone  2006-01-02 15:04:05.999999999, as the server holds it
//	binary             \x and hex up to BinaryHexMax bytes; past it [binary, N bytes, sha256 …]
//	text               as it is, with bytes that are not UTF-8 replaced
//
// The rest of the runner never speaks an engine's dialect: this file is the one place a pull's
// and a query's SQL differ by engine, beside each engine's own file.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	mssql "github.com/microsoft/go-mssqldb"
	go_ora "github.com/sijms/go-ora/v2"
)

// BinaryHexMax is the most bytes a binary value keeps as hex; a longer one is named by its size
// and its hash, so a change to it still changes its row's hash.
const BinaryHexMax = 1024

// Quote is a name as the engine quotes it: "name" (Postgres, Oracle), [name] (SQL Server), `name`
// (MySQL), each with its quote doubled inside.
func Quote(engine, name string) string {
	switch engine {
	case "sqlserver":
		return "[" + strings.ReplaceAll(name, "]", "]]") + "]"
	case "mysql":
		return "`" + strings.ReplaceAll(name, "`", "``") + "`"
	default:
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	}
}

// Table is a table's two-part name as the engine reads it: schema.name (the database, for MySQL).
func Table(engine, schema, name string) string {
	return Quote(engine, schema) + "." + Quote(engine, name)
}

// Column is a column of a result: its name, and its type in the engine's words with its size.
type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
	// base is the driver's own type name, upper case, which says how a value of it reads.
	base string
}

// Columns reads a table's columns, in its order, from a statement that answers no row.
func Columns(ctx context.Context, q Querier, engine, schema, name string) ([]Column, error) {
	rows, err := q.QueryContext(ctx, "SELECT * FROM "+Table(engine, schema, name)+" WHERE 1 = 0 /* pull:columns */")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	return ColumnsOf(types), rows.Err()
}

// ColumnsOf names a result's columns and their types.
func ColumnsOf(types []*sql.ColumnType) []Column {
	out := make([]Column, len(types))
	for i, t := range types {
		out[i] = Column{Name: t.Name(), Type: typeText(t), base: strings.ToUpper(t.DatabaseTypeName())}
	}
	return out
}

// NewColumn is a column of a known driver type, for tests.
func NewColumn(name, driverType string) Column {
	return Column{Name: name, Type: strings.ToLower(driverType), base: strings.ToUpper(driverType)}
}

func typeText(t *sql.ColumnType) string {
	name := strings.ToLower(t.DatabaseTypeName())
	if name == "" {
		return "unknown"
	}
	if p, s, ok := t.DecimalSize(); ok && p > 0 && p < 1000 {
		return fmt.Sprintf("%s(%d,%d)", name, p, s)
	}
	if n, ok := t.Length(); ok && n > 0 && n < math.MaxInt32 {
		return fmt.Sprintf("%s(%d)", name, n)
	}
	return name
}

// Select is the statement a pull reads a table with: every column in order, and no ORDER BY, so the
// database reads the table the cheapest way it knows. Oracle's numbers are read as text, so a key
// past a float's 53 bits keeps every digit and the decimal mark never follows the session's
// language.
func Select(engine, schema, name string, columns []Column) string {
	return "SELECT " + columnList(engine, columns) + " FROM " + Table(engine, schema, name) + " /* pull:rows */"
}

// columnList is a read's columns in order, each read the way Text answers it the same on every run.
func columnList(engine string, columns []Column) string {
	parts := make([]string, len(columns))
	for i, c := range columns {
		parts[i] = Quote(engine, c.Name)
		if engine == "oracle" && oracleNumber(c.base) {
			parts[i] = "TO_CHAR(" + parts[i] + ", 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')"
		}
	}
	return strings.Join(parts, ", ")
}

func oracleNumber(base string) bool {
	switch base {
	case "NUMBER", "FLOAT", "BINARY_FLOAT", "BINARY_DOUBLE", "IBFLOAT", "IBDOUBLE":
		return true
	}
	return false
}

// KeyColumns reads a table's primary key, its columns in key order; none for a table without one
// (a view, a heap).
func KeyColumns(ctx context.Context, q Querier, engine, schema, name string) ([]string, error) {
	var query string
	args := []any{schema, name}
	switch engine {
	case "postgres":
		query = `SELECT a.attname FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2
ORDER BY k.ord /* pull:key */`
	case "sqlserver":
		query = `SELECT c.name FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(QUOTENAME(@p1) + N'.' + QUOTENAME(@p2))
ORDER BY ic.key_ordinal /* pull:key */`
	case "mysql":
		query = `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
ORDER BY ORDINAL_POSITION /* pull:key */`
	case "oracle":
		query = `SELECT cc.COLUMN_NAME FROM ALL_CONSTRAINTS c
JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
WHERE c.CONSTRAINT_TYPE = 'P' AND c.OWNER = :1 AND c.TABLE_NAME = :2
ORDER BY cc.POSITION /* pull:key */`
	default:
		return nil, fmt.Errorf("no engine %q", engine)
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	key := []string{}
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			return nil, err
		}
		key = append(key, column)
	}
	return key, rows.Err()
}

// Text is a value as a pull and a query keep it: nil for NULL, else its one form for its kind
// (the file's comment lists them).
func Text(v any, c Column) *string {
	if v == nil {
		return nil
	}
	s := textOf(v, c)
	return &s
}

func textOf(v any, c Column) string {
	switch x := v.(type) {
	case string:
		return validText(x)
	case []byte:
		switch {
		case c.base == "UNIQUEIDENTIFIER" && len(x) == 16:
			var u mssql.UniqueIdentifier
			if u.Scan(x) == nil {
				return u.String()
			}
			return binaryText(x)
		case binaryType(c.base):
			return binaryText(x)
		default:
			// MySQL answers every value as its text; SQL Server its decimals and money; Postgres its JSON.
			return validText(string(x))
		}
	case int64:
		return strconv.FormatInt(x, 10)
	case int32:
		return strconv.FormatInt(int64(x), 10)
	case int:
		return strconv.Itoa(x)
	case int16:
		return strconv.FormatInt(int64(x), 10)
	case int8:
		return strconv.FormatInt(int64(x), 10)
	case uint64:
		return strconv.FormatUint(x, 10)
	case uint32:
		return strconv.FormatUint(uint64(x), 10)
	case float64:
		if c.base == "FLOAT4" || c.base == "REAL" {
			// pgx and go-mssqldb answer a 32-bit float as a float64: its shortest digits are a float32's.
			return floatText(x, 32)
		}
		return floatText(x, 64)
	case float32:
		return floatText(float64(x), 32)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case time.Time:
		return timeText(x, c.base)
	case go_ora.BFile:
		// Its locator holds the connection, which prints differently on each run. What it names does not.
		return "[file " + x.GetDirName() + "/" + x.GetFileName() + "]"
	case fmt.Stringer:
		return validText(x.String())
	}
	return validText(fmt.Sprint(v))
}

func floatText(f float64, bits int) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	return strconv.FormatFloat(f, 'g', -1, bits)
}

// zoned is a type whose values are moments in a zone, read in UTC.
func zoned(base string) bool {
	switch base {
	case "TIMESTAMPTZ", "DATETIMEOFFSET", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITH LOCAL TIME ZONE", "TIMESTAMPTZ_DTY", "TIMESTAMPLTZ_DTY":
		return true
	}
	return strings.Contains(base, "TIME ZONE")
}

func timeText(t time.Time, base string) string {
	switch {
	case base == "DATE" && t.Hour() == 0 && t.Minute() == 0 && t.Second() == 0 && t.Nanosecond() == 0:
		// Oracle's DATE holds a time of day too: only a whole day reads as a date.
		return t.Format("2006-01-02")
	case base == "TIME":
		return t.Format("15:04:05.999999999")
	case zoned(base):
		return t.UTC().Format(time.RFC3339Nano)
	}
	return t.Format("2006-01-02 15:04:05.999999999")
}

// binaryType is a type whose values are bytes, not text.
func binaryType(base string) bool {
	switch base {
	case "BYTEA", "BINARY", "VARBINARY", "IMAGE", "BLOB", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB", "RAW", "LONG RAW", "BFILE", "BIT", "GEOMETRY", "TIMESTAMP_BINARY", "ROWVERSION",
		// As go-ora and go-mssqldb name them.
		"LONGRAW", "OCIBLOBLOCATOR", "GEOGRAPHY", "HIERARCHYID":
		return true
	}
	return false
}

func binaryText(b []byte) string {
	if len(b) <= BinaryHexMax {
		return `\x` + hex.EncodeToString(b)
	}
	sum := sha256.Sum256(b)
	return fmt.Sprintf("[binary, %d bytes, sha256 %s]", len(b), hex.EncodeToString(sum[:8]))
}

func validText(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	return strings.ToValidUTF8(s, "�")
}

// Scan reads one row into values a driver answers, ready for Text.
func Scan(rows *sql.Rows, n int) ([]any, error) {
	values := make([]any, n)
	ptrs := make([]any, n)
	for i := range values {
		ptrs[i] = &values[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	return values, nil
}

// WriteWords are the words a statement that only reads never holds outside quotes and comments.
// SQL Server runs statements with nothing between them ("SELECT 1 COMMIT DELETE FROM t") and has no
// read-only transaction, so these are refused wherever they stand, not only first. The api's check
// holds the same list, and apps/data-runner/contract/vectors/query-refusal.json names it for both.
var WriteWords = []string{
	"INTO", "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "REVOKE", "DENY",
	"EXEC", "EXECUTE", "COMMIT", "ROLLBACK", "BACKUP", "RESTORE", "DBCC", "KILL", "SHUTDOWN", "RECONFIGURE",
	"OPENROWSET", "OPENDATASOURCE", "OPENQUERY",
}

var (
	writeWord = func() map[string]bool {
		words := make(map[string]bool, len(WriteWords))
		for _, w := range WriteWords {
			words[w] = true
		}
		return words
	}()
	sqlWord = regexp.MustCompile(`[A-Za-z_$@][A-Za-z0-9_$@]*`)
)

// QueryRefusal says why a query's SQL is not one statement that only reads, or "" when it is: one
// statement, SELECT or WITH first, and no word of WriteWords outside quotes and comments. Anything
// the four engines read differently is refused rather than guessed at. A read-only transaction and
// the read login stand behind this; on SQL Server, which has no read-only transaction, this and the
// login are the line.
func QueryRefusal(sql string) string {
	bare, why := bareSQL(sql)
	if why != "" {
		return why
	}
	bare = strings.ToUpper(strings.TrimSpace(bare))
	if bare == "" {
		return "A query needs a SELECT statement."
	}
	words := sqlWord.FindAllString(bare, -1)
	if len(words) == 0 || (words[0] != "SELECT" && words[0] != "WITH") || !strings.HasPrefix(bare, words[0]) {
		return "A query reads: it starts with SELECT or WITH."
	}
	if semicolon := strings.Index(bare, ";"); semicolon >= 0 && strings.TrimSpace(bare[semicolon+1:]) != "" {
		return "A query is one statement."
	}
	for _, word := range words {
		if word == "INTO" {
			return "A query reads: SELECT INTO writes, so it does not run."
		}
		if writeWord[word] {
			return "A query reads: " + word + " changes the database, so it does not run. A column of that name is quoted."
		}
	}
	return ""
}

// bareSQL is SQL without its quoted text and comments, each one space, whichever quotes the engines
// use; or why the text cannot be read the same way on every engine. A comment MySQL would run, a
// `#` (a comment there, an operator elsewhere), `--` with no space after it (MySQL reads minus
// signs), a backslash before a quote (MySQL escapes it, the others end the string), and quotes or
// comments left open are all refused.
func bareSQL(sql string) (string, string) {
	const (
		open      = "A query's quotes and comments are closed."
		backslash = "A query writes a quote inside a string as two quotes, with no backslash before it."
		dashes    = "A query's -- comment has a space after it."
		hash      = "A query has no # outside quotes: on MySQL it starts a comment."
		runnable  = "A query has no comment MySQL would run (/*! ... */)."
	)
	var b strings.Builder
	for i := 0; i < len(sql); {
		switch c := sql[i]; {
		case c == '\'' || c == '"' || c == '`':
			j, closed := i+1, false
			for j < len(sql) {
				if c != '`' && sql[j] == '\\' && j+1 < len(sql) && sql[j+1] == c {
					return "", backslash
				}
				if sql[j] == c {
					if j+1 < len(sql) && sql[j+1] == c {
						j += 2
						continue
					}
					closed = true
					break
				}
				j++
			}
			if !closed {
				return "", open
			}
			i = j + 1
			b.WriteByte(' ')
		case c == '[':
			j := strings.IndexByte(sql[i:], ']')
			if j < 0 {
				return "", open
			}
			i += j + 1
			b.WriteByte(' ')
		case c == '#':
			return "", hash
		case c == '-' && i+1 < len(sql) && sql[i+1] == '-':
			if i+2 < len(sql) && !strings.ContainsRune(" \t\r\n", rune(sql[i+2])) {
				return "", dashes
			}
			j := strings.IndexByte(sql[i:], '\n')
			if j < 0 {
				i = len(sql)
			} else {
				i += j + 1
			}
			b.WriteByte(' ')
		case c == '/' && i+1 < len(sql) && sql[i+1] == '*':
			if strings.HasPrefix(sql[i+2:], "!") || strings.HasPrefix(sql[i+2:], "M!") {
				return "", runnable
			}
			j := strings.Index(sql[i+2:], "*/")
			if j < 0 {
				return "", open
			}
			i += j + 4
			b.WriteByte(' ')
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String(), ""
}
