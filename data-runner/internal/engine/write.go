package engine

// The statements a push and a compare run, in each engine's dialect: reading a table's rows by key
// (locked, for a write's batch), inserting, updating and deleting rows by key, counting a table's
// rows, and which columns a new row must fill. Every value is a parameter, never text in the SQL;
// every name is quoted (Quote).

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Placeholder is the engine's n-th parameter, from 1: ? (MySQL), $1 (Postgres), @p1 (SQL Server),
// :1 (Oracle).
func Placeholder(engine string, n int) string {
	switch engine {
	case "postgres":
		return "$" + strconv.Itoa(n)
	case "sqlserver":
		return "@p" + strconv.Itoa(n)
	case "oracle":
		return ":" + strconv.Itoa(n)
	}
	return "?"
}

// ParamsMax is the most parameters one statement binds: SQL Server takes at most 2,100, and Oracle at
// most 1,000 items in a list; MySQL and Postgres take far more.
func ParamsMax(engine string) int {
	switch engine {
	case "sqlserver":
		return 2_000
	case "oracle":
		return 1_000
	}
	return 20_000
}

// KeysPerRead is how many keys one read by key names, at most `most`.
func KeysPerRead(engine string, keyColumns, most int) int {
	n := ParamsMax(engine) / max(keyColumns, 1)
	if engine == "oracle" && keyColumns > 1 {
		// A list of tuples is still at most 1,000 items.
		n = min(n, 1_000)
	}
	return max(1, min(n, most))
}

// RowsPerInsert is how many rows one insert writes: as many as its parameters allow, at most `most`.
// SQL Server takes at most 1,000 rows in one VALUES, and Oracle's INSERT ALL is kept short: its INTO
// clauses name at most 999 columns between them.
func RowsPerInsert(engine string, columns, most int) int {
	n := ParamsMax(engine) / max(columns, 1)
	switch engine {
	case "sqlserver":
		n = min(n, 1_000)
	case "oracle":
		n = min(n, 100, 999/max(columns, 1))
	}
	return max(1, min(n, most))
}

func placeholders(engine string, first, n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = Placeholder(engine, first+i)
	}
	return strings.Join(parts, ", ")
}

func quotedNames(engine string, columns []Column, at []int) []string {
	out := make([]string, len(at))
	for i, a := range at {
		out[i] = Quote(engine, columns[a].Name)
	}
	return out
}

// keyMatch is the condition that a row's key is one of n keys, its parameters numbered from first,
// each key's columns in key order.
func keyMatch(engine string, columns []Column, key []int, n, first int) string {
	names := quotedNames(engine, columns, key)
	if len(key) == 1 {
		return names[0] + " IN (" + placeholders(engine, first, n) + ")"
	}
	if engine == "sqlserver" {
		// SQL Server has no tuple IN.
		ors := make([]string, n)
		p := first
		for i := range ors {
			ands := make([]string, len(names))
			for j, name := range names {
				ands[j] = name + " = " + Placeholder(engine, p)
				p++
			}
			ors[i] = "(" + strings.Join(ands, " AND ") + ")"
		}
		return "(" + strings.Join(ors, " OR ") + ")"
	}
	tuples := make([]string, n)
	for i := range tuples {
		tuples[i] = "(" + placeholders(engine, first+i*len(key), len(key)) + ")"
	}
	return "(" + strings.Join(names, ", ") + ") IN (" + strings.Join(tuples, ", ") + ")"
}

// SelectByKeys reads the rows whose key is one of n keys: every column in order, each as Text reads
// it. lock takes the rows for the transaction it runs in, so nothing changes them before it ends; on
// SQL Server it also takes the range a missing key falls in, so nothing adds that key meanwhile.
func SelectByKeys(engine, schema, name string, columns []Column, key []int, n int, lock bool) string {
	from := Table(engine, schema, name)
	if lock && engine == "sqlserver" {
		from += " WITH (UPDLOCK, HOLDLOCK)"
	}
	s := "SELECT " + columnList(engine, columns) + " FROM " + from + " WHERE " + keyMatch(engine, columns, key, n, 1)
	if lock && engine != "sqlserver" {
		s += " FOR UPDATE"
	}
	return s + " /* push:rows */"
}

// InsertRows inserts n rows of every column, in order. Oracle has no VALUES of several rows: INSERT
// ALL names each.
func InsertRows(engine, schema, name string, columns []Column, n int) string {
	all := make([]int, len(columns))
	for i := range all {
		all[i] = i
	}
	list := "(" + strings.Join(quotedNames(engine, columns, all), ", ") + ")"
	table := Table(engine, schema, name)
	var b strings.Builder
	// One row goes in a plain INSERT on every engine: Oracle's INSERT ALL could not name the columns of
	// a table of 1,000.
	if engine == "oracle" && n > 1 {
		b.WriteString("INSERT ALL")
		for r := 0; r < n; r++ {
			fmt.Fprintf(&b, " INTO %s %s VALUES (%s)", table, list, placeholders(engine, 1+r*len(columns), len(columns)))
		}
		b.WriteString(" SELECT 1 FROM DUAL /* push:insert */")
		return b.String()
	}
	fmt.Fprintf(&b, "INSERT INTO %s %s VALUES ", table, list)
	for r := 0; r < n; r++ {
		if r > 0 {
			b.WriteString(", ")
		}
		b.WriteString("(" + placeholders(engine, 1+r*len(columns), len(columns)) + ")")
	}
	b.WriteString(" /* push:insert */")
	return b.String()
}

// UpdateRow sets the columns of `set` in the one row whose key matches: the set columns' values
// first, then the key's.
func UpdateRow(engine, schema, name string, columns []Column, set, key []int) string {
	sets := make([]string, len(set))
	for i, a := range set {
		sets[i] = Quote(engine, columns[a].Name) + " = " + Placeholder(engine, 1+i)
	}
	where := make([]string, len(key))
	for i, a := range key {
		where[i] = Quote(engine, columns[a].Name) + " = " + Placeholder(engine, 1+len(set)+i)
	}
	return "UPDATE " + Table(engine, schema, name) + " SET " + strings.Join(sets, ", ") + " WHERE " + strings.Join(where, " AND ") + " /* push:update */"
}

// SelectDistinctIn reads which of n values a table's column holds: the column's distinct values among
// them, each as Text reads it. A preview's links read the table a link names this way, by value, as
// many values a statement as KeysPerRead allows for a key of one column.
func SelectDistinctIn(engine, schema, name string, column Column, n int) string {
	return "SELECT DISTINCT " + columnList(engine, []Column{column}) + " FROM " + Table(engine, schema, name) +
		" WHERE " + Quote(engine, column.Name) + " IN (" + placeholders(engine, 1, n) + ") /* push:links */"
}

// DeleteByKeys deletes the rows whose key is one of n keys.
func DeleteByKeys(engine, schema, name string, columns []Column, key []int, n int) string {
	return "DELETE FROM " + Table(engine, schema, name) + " WHERE " + keyMatch(engine, columns, key, n, 1) + " /* push:delete */"
}

// CountRows counts a table's rows.
func CountRows(engine, schema, name string) string {
	return "SELECT COUNT(*) FROM " + Table(engine, schema, name) + " /* push:count */"
}

// RequiredColumns reads the columns a new row must give a value: NOT NULL, with no default, and
// neither an identity, computed, nor (SQL Server) a rowversion.
func RequiredColumns(ctx context.Context, q Querier, engine, schema, name string) ([]string, error) {
	var query string
	switch engine {
	case "mysql":
		query = `SELECT COLUMN_NAME FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL
  AND EXTRA NOT LIKE '%auto_increment%' AND EXTRA NOT LIKE '%GENERATED%'
ORDER BY ORDINAL_POSITION /* push:required */`
	case "postgres":
		query = `SELECT column_name FROM information_schema.columns
WHERE table_schema = $1 AND table_name = $2 AND is_nullable = 'NO' AND column_default IS NULL
  AND is_identity = 'NO' AND coalesce(is_generated, 'NEVER') = 'NEVER'
ORDER BY ordinal_position /* push:required */`
	case "sqlserver":
		query = `SELECT c.name FROM sys.columns c
WHERE c.object_id = OBJECT_ID(QUOTENAME(@p1) + N'.' + QUOTENAME(@p2)) AND c.is_nullable = 0 AND c.default_object_id = 0
  AND c.is_identity = 0 AND c.is_computed = 0 AND TYPE_NAME(c.system_type_id) <> 'timestamp'
ORDER BY c.column_id /* push:required */`
	case "oracle":
		query = `SELECT COLUMN_NAME FROM ALL_TAB_COLS
WHERE OWNER = :1 AND TABLE_NAME = :2 AND NULLABLE = 'N' AND DATA_DEFAULT IS NULL
  AND HIDDEN_COLUMN = 'NO' AND VIRTUAL_COLUMN = 'NO'
ORDER BY COLUMN_ID /* push:required */`
	default:
		return nil, fmt.Errorf("no engine %q", engine)
	}
	rows, err := q.QueryContext(ctx, query, schema, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			return nil, err
		}
		out = append(out, column)
	}
	return out, rows.Err()
}

// A value a database's error quotes: in single or double quotes, or a key's value in parentheses. A
// name it quotes stays: after "column", "key", "table" and the like, or after a dot. MySQL and SQL
// Server quote a value as it is, quotes inside it and all ('O'Brien'), so where a message says what
// follows its value, the value runs to there.
var (
	valueThen = []struct {
		re   *regexp.Regexp
		with string
	}{
		// MySQL 1062: Duplicate entry 'X' for key 'name'
		{regexp.MustCompile(`(?i)(duplicate entry )'.*'( for key )`), "${1}'…'${2}"},
		// MySQL 1366 and 1292: Incorrect integer value: 'X' for column 'name'
		{regexp.MustCompile(`(?i)( value: )'.*'( for column )`), "${1}'…'${2}"},
		// MySQL 1292: Truncated incorrect DOUBLE value: 'X'
		{regexp.MustCompile(`(?i)(truncated incorrect [a-z ]+ value: )'.*'`), "${1}'…'"},
		// SQL Server 245: Conversion failed when converting the nvarchar value 'X' to data type int.
		{regexp.MustCompile(`(?i)( value )'.*'( to data type )`), "${1}'…'${2}"},
		// SQL Server 2628: String or binary data would be truncated … Truncated value: 'X'.
		{regexp.MustCompile(`(?i)(truncated value: )'.*'`), "${1}'…'"},
		// Postgres 22P02: invalid input syntax for type integer: "X"
		{regexp.MustCompile(`(?i)(invalid input syntax for type [^:"]+: )".*"`), `${1}"…"`},
		// SQL Server 2627 and 2601: The duplicate key value is (X).
		{regexp.MustCompile(`(?i)(key value is )\(.*\)\.`), "${1}(…)."},
		// Postgres's key detail: Key (permit_no)=(X) already exists.
		{regexp.MustCompile(`=\(.*\)( already exists| is not present| conflicts with)`), "=(…)${1}"},
	}
	keyValue     = regexp.MustCompile(`(?i)(key value is )\([^)]*\)`)
	pgKeyDetail  = regexp.MustCompile(`=\([^)]*\)`)
	nameBeforeRe = regexp.MustCompile(`(?i)(column|key|table|relation|constraint|index|schema|database|type|function|trigger|view|sequence|object|for|of|in)\s*$`)
)

// ScrubValues takes the row values out of a database's error, so the error a write or a compare
// answers says what went wrong and with which column, and holds none of the row's data: a value in
// quotes becomes '…' unless a word such as "column" or "key" names it as a name. Scrub the database's
// own words before other words join them: a quote of theirs could pair with one of the value's.
func ScrubValues(message string) string {
	for _, v := range valueThen {
		message = v.re.ReplaceAllString(message, v.with)
	}
	message = keyValue.ReplaceAllString(message, "${1}(…)")
	message = pgKeyDetail.ReplaceAllString(message, "=(…)")
	var b strings.Builder
	last := 0
	for _, at := range quotedSpans(message) {
		b.WriteString(message[last:at[0]])
		quoted := message[at[0]:at[1]]
		// A name's next part follows its dot: "OWNER"."PERMITS"."STATUS".
		if nameBeforeRe.MatchString(message[:at[0]]) || strings.HasSuffix(message[:at[0]], ".") {
			b.WriteString(quoted)
		} else {
			b.WriteString(quoted[:1] + "…" + quoted[:1])
		}
		last = at[1]
	}
	b.WriteString(message[last:])
	return b.String()
}

// quotedSpans are a message's quoted parts: each from a quote that begins a word to the next quote of
// its kind that ends one. A quote inside a word ("batch's", the O'Brien of a value) neither opens nor
// ends a part, a doubled quote is the value's own, and a part that never ends runs to the message's
// end. A quote of its kind further on that ends a word, before any that begins one, is the part's
// too: "the value 'x' y' is wrong" quotes x' y.
func quotedSpans(s string) [][2]int {
	var out [][2]int
	for i := 0; i < len(s); i++ {
		q := s[i]
		if (q != '\'' && q != '"') || (i > 0 && wordByte(s[i-1])) {
			continue
		}
		end := len(s)
		for j := i + 1; j < len(s); j++ {
			if s[j] != q {
				continue
			}
			if j+1 < len(s) && s[j+1] == q {
				j++
				continue
			}
			if j+1 == len(s) || !wordByte(s[j+1]) {
				end = j + 1
				break
			}
		}
		for j := end; j < len(s); j++ {
			if s[j] != q {
				continue
			}
			if !wordByte(s[j-1]) {
				break
			}
			if j+1 == len(s) || !wordByte(s[j+1]) {
				end = j + 1
			}
		}
		out = append(out, [2]int{i, end})
		i = end - 1
	}
	return out
}

// wordByte is a byte of a word: a letter, a digit, an underscore, or part of a character past ASCII.
func wordByte(b byte) bool {
	return b >= 0x80 || b == '_' || ('0' <= b && b <= '9') || ('a' <= b && b <= 'z') || ('A' <= b && b <= 'Z')
}

// MySQLRollsBack says whether a MySQL table's changes roll back with their transaction, and names its
// engine: InnoDB's do; MyISAM's stay written whatever the transaction does. The server's own list of
// engines says which have transactions. A view names no engine, nor does a table the login cannot see:
// neither rolls back as far as the runner can tell.
func MySQLRollsBack(ctx context.Context, q Querier, schema, name string) (string, bool, error) {
	var engineName, transactions sql.NullString
	err := q.QueryRowContext(ctx, `SELECT t.ENGINE, e.TRANSACTIONS FROM information_schema.TABLES t
LEFT JOIN information_schema.ENGINES e ON e.ENGINE = t.ENGINE
WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ? /* push:engine */`, schema, name).Scan(&engineName, &transactions)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return engineName.String, strings.EqualFold(transactions.String, "YES"), nil
}
