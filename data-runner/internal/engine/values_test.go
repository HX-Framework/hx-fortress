package engine

import (
	"bytes"
	"strings"
	"testing"

	mssql "github.com/microsoft/go-mssqldb"
)

func sp(s string) *string { return &s }

func TestSameReadsValuesAsTheColumnHoldsThem(t *testing.T) {
	cases := []struct {
		engine, driverType, store, db string
		same                          bool
	}{
		{"mysql", "DECIMAL", "175", "175.00", true},
		{"mysql", "DECIMAL", "175.5", "175.50", true},
		{"mysql", "DECIMAL", "1.75e2", "175.00", true},
		{"mysql", "DECIMAL", "175.01", "175.00", false},
		{"postgres", "NUMERIC", "-0.10", "-0.1", true},
		{"mysql", "INT", "0042", "42", true},
		{"mysql", "TINYINT", "true", "1", true},
		{"mysql", "TINYINT", "false", "0", true},
		{"postgres", "BOOL", "1", "true", true},
		{"postgres", "BOOL", "f", "false", true},
		{"sqlserver", "BIT", "true", "true", true},
		{"mysql", "BIT", "1", `\x01`, true},
		{"mysql", "BIT", "true", `\x00`, false},
		{"mysql", "DATE", "2026-01-02", "2026-01-02", true},
		{"mysql", "DATE", "2026-01-02 00:00:00", "2026-01-02", true},
		{"mysql", "DATE", "2026-01-02T10:00:00", "2026-01-02", false},
		{"mysql", "DATETIME", "2026-01-02T03:04:05", "2026-01-02 03:04:05", true},
		{"mysql", "DATETIME", "2026-01-02 03:04:05.000", "2026-01-02 03:04:05", true},
		{"oracle", "DATE", "2026-01-02", "2026-01-02", true},
		{"oracle", "DATE", "2026-01-02 00:00:00", "2026-01-02", true},
		{"postgres", "TIMESTAMPTZ", "2026-01-02T05:04:05+02:00", "2026-01-02T03:04:05Z", true},
		{"postgres", "TIMESTAMPTZ", "2026-01-02 03:04:05", "2026-01-02T03:04:05Z", true},
		{"postgres", "TIME", "09:30", "09:30:00", true},
		{"mysql", "CHAR", "BP-1", "BP-1   ", true},
		{"mysql", "VARCHAR", "BP-1", "BP-1   ", false},
		{"mysql", "VARCHAR", "bp-1", "BP-1", false},
		{"mysql", "VARCHAR", "175", "175.00", false},
		{"mysql", "DECIMAL", "abc", "175.00", false},
	}
	for _, c := range cases {
		col := NewColumn("c", c.driverType)
		if got := Same(c.engine, col, sp(c.store), sp(c.db)); got != c.same {
			t.Errorf("%s %s: Same(%q, %q) = %t, want %t", c.engine, c.driverType, c.store, c.db, got, c.same)
		}
	}
	col := NewColumn("c", "VARCHAR")
	if !Same("mysql", col, nil, nil) || Same("mysql", col, nil, sp("")) || Same("mysql", col, sp(""), nil) {
		t.Fatal("NULL is the same as NULL and as nothing else")
	}
}

func TestCanonKeyFindsOneRowWrittenTwoWays(t *testing.T) {
	cols := []Column{NewColumn("town", "INT"), NewColumn("permit", "VARCHAR")}
	a := CanonKey("mysql", cols, []*string{sp("0042"), sp("BP-1")}, []int{0, 1})
	b := CanonKey("mysql", cols, []*string{sp("42"), sp("BP-1")}, []int{0, 1})
	c := CanonKey("mysql", cols, []*string{sp("42"), sp("bp-1")}, []int{0, 1})
	if a != b || a == c {
		t.Fatalf("keys %q %q %q", a, b, c)
	}
	if FoldKey("mysql", cols, []*string{sp("42"), sp("bp-1")}, []int{0, 1}) != FoldKey("mysql", cols, []*string{sp("42"), sp("BP-1")}, []int{0, 1}) {
		t.Fatal("a key's case folds")
	}
	// A key of one column whose value holds the separator still names one row.
	one := []Column{NewColumn("k", "VARCHAR")}
	if CanonKey("mysql", one, []*string{sp("a\x00b")}, []int{0}) == CanonKey("mysql", one, []*string{sp("a")}, []int{0}) {
		t.Fatal("two keys read as one")
	}
}

func TestBindWritesWhatTheDatabaseReadsTheSameEverywhere(t *testing.T) {
	if got := Bind("mysql", NewColumn("ok", "TINYINT"), sp("true")); got != "1" {
		t.Fatalf("a yes into MySQL's tinyint: %#v", got)
	}
	if got := Bind("mysql", NewColumn("flag", "BIT"), sp("1")); got != int64(1) {
		t.Fatalf("MySQL's BIT: %#v", got)
	}
	if got := Bind("mysql", NewColumn("raw", "VARBINARY"), sp(`\xdeadbeef`)); !bytes.Equal(got.([]byte), []byte{0xde, 0xad, 0xbe, 0xef}) {
		t.Fatalf("bytes: %#v", got)
	}
	if got := Bind("postgres", NewColumn("raw", "BYTEA"), sp(`\xdeadbeef`)); got != `\xdeadbeef` {
		t.Fatalf("Postgres reads bytea's own text form: %#v", got)
	}
	if got := Bind("sqlserver", NewColumn("at", "DATETIME"), sp("2026-01-02 03:04:05")); got != "2026-01-02T03:04:05" {
		t.Fatalf("SQL Server's datetime: %#v", got)
	}
	if got := Bind("sqlserver", NewColumn("on", "DATE"), sp("2026-01-02")); got != "2026-01-02" {
		t.Fatalf("SQL Server's date: %#v", got)
	}
	if got := Bind("oracle", NewColumn("on", "DATE"), sp("2026-01-02")); got != "2026-01-02 00:00:00" {
		t.Fatalf("Oracle's DATE: %#v", got)
	}
	if got := Bind("oracle", NewColumn("at", "TIMESTAMP"), sp("2026-01-02T03:04:05.5")); got != "2026-01-02 03:04:05.500000000" {
		t.Fatalf("Oracle's TIMESTAMP: %#v", got)
	}
	if got := Bind("mysql", NewColumn("note", "VARCHAR"), sp("as it is")); got != "as it is" {
		t.Fatalf("text: %#v", got)
	}
	if got := Bind("mysql", NewColumn("note", "VARCHAR"), nil); got != nil {
		t.Fatalf("NULL: %#v", got)
	}
	if !TooLongToWrite("mysql", NewColumn("raw", "BLOB"), sp("[binary, 4096 bytes, sha256 0011]")) || TooLongToWrite("mysql", NewColumn("note", "TEXT"), sp("[binary, 1 bytes")) {
		t.Fatal("a binary value too long to have been kept")
	}
}

func TestScrubValuesKeepsNamesAndDropsValues(t *testing.T) {
	cases := map[string]string{
		"MySQL answered: Duplicate entry 'BP-1' for key 'permits.PRIMARY' (error 1062)":              "MySQL answered: Duplicate entry '…' for key 'permits.PRIMARY' (error 1062)",
		"Incorrect integer value: 'abc' for column 'fee' at row 1":                                   "Incorrect integer value: '…' for column 'fee' at row 1",
		`invalid input syntax for type integer: "abc" (22P02)`:                                       `invalid input syntax for type integer: "…" (22P02)`,
		`null value in column "status" of relation "permits" violates not-null constraint`:           `null value in column "status" of relation "permits" violates not-null constraint`,
		"Violation of PRIMARY KEY constraint 'PK_p'. The duplicate key value is (BP-1).":             "Violation of PRIMARY KEY constraint 'PK_p'. The duplicate key value is (…).",
		"Conversion failed when converting the nvarchar value 'Final!' to data type int.":            "Conversion failed when converting the nvarchar value '…' to data type int.",
		`ORA-12899: value too large for column "OWNER"."PERMITS"."STATUS" (actual: 30, maximum: 20)`: `ORA-12899: value too large for column "OWNER"."PERMITS"."STATUS" (actual: 30, maximum: 20)`,
		"Key (permit_no)=(BP-1) already exists.":                                                     "Key (permit_no)=(…) already exists.",
	}
	for in, want := range cases {
		if got := ScrubValues(in); got != want {
			t.Errorf("ScrubValues(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

// MySQL and SQL Server quote a value as it is, its own quotes and all, and the runner's words have
// quotes of their own ("the batch's"): no part of a value is left.
func TestScrubValuesLeavesNothingOfAValueWithQuotesInIt(t *testing.T) {
	cases := map[string]string{
		"MySQL answered: Duplicate entry 'O'Brien' for key 'users.PRIMARY' (error 1062)":                                                                            "MySQL answered: Duplicate entry '…' for key 'users.PRIMARY' (error 1062)",
		"MySQL answered: Incorrect integer value: 'it's 5' for column 'qty' at row 1 (error 1366)":                                                                  "MySQL answered: Incorrect integer value: '…' for column 'qty' at row 1 (error 1366)",
		"SQL Server answered: Conversion failed when converting the nvarchar value 'Joe's Bar' to data type int. (error 245)":                                       "SQL Server answered: Conversion failed when converting the nvarchar value '…' to data type int. (error 245)",
		"SQL Server answered: String or binary data would be truncated in table 'shop.dbo.permits', column 'status'. Truncated value: 'Final's-and-'. (error 2628)": "SQL Server answered: String or binary data would be truncated in table 'shop.dbo.permits', column 'status'. Truncated value: '…'. (error 2628)",
		"SQL Server answered: Violation of PRIMARY KEY constraint 'PK_p'. The duplicate key value is (B) (2). (error 2627)":                                         "SQL Server answered: Violation of PRIMARY KEY constraint 'PK_p'. The duplicate key value is (…). (error 2627)",
		`The database answered: invalid input syntax for type integer: "say "hi"" (22P02)`:                                                                          `The database answered: invalid input syntax for type integer: "…" (22P02)`,
		"Could not insert the batch's new rows into shop.permits. MySQL answered: Duplicate entry 'BP-1' for key 'permits.PRIMARY' (error 1062)":                    "Could not insert the batch's new rows into shop.permits. MySQL answered: Duplicate entry '…' for key 'permits.PRIMARY' (error 1062)",
		"Some engine said: the value 'x' y' is wrong":                                                                                                               "Some engine said: the value '…' is wrong",
		"Some engine said: the value 'never ends":                                                                                                                   "Some engine said: the value '…'",
	}
	for in, want := range cases {
		if got := ScrubValues(in); got != want {
			t.Errorf("ScrubValues(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

func TestBindWritesNumbersAndMomentsAsEachEngineReadsThem(t *testing.T) {
	cases := []struct {
		engine, driverType, store string
		want                      any
	}{
		{"postgres", "INT4", "212.0", "212"},
		{"postgres", "INT8", "0042", "42"},
		{"sqlserver", "DECIMAL", "1.75e2", "175"},
		{"postgres", "NUMERIC", "1.0e-05", "0.00001"},
		{"sqlserver", "MONEY", "-12.50", "-12.5"},
		{"mysql", "DECIMAL", "abc", "abc"},
		{"postgres", "NUMERIC", "1e999", "1e999"},
		{"postgres", "TIMESTAMPTZ", "2026-01-02 03:04:05", "2026-01-02T03:04:05Z"},
		{"postgres", "TIMESTAMPTZ", "2026-01-02 10:00:00+02", "2026-01-02T08:00:00Z"},
		{"postgres", "TIMESTAMP", "2026-01-02 03:04:05", "2026-01-02 03:04:05"},
		{"sqlserver", "DATETIME", "2026-01-02T03:04:05.123456", "2026-01-02T03:04:05.123"},
		{"sqlserver", "SMALLDATETIME", "2026-01-02 03:04:05.5", "2026-01-02T03:04:06"},
		{"sqlserver", "DATETIME2", "2026-01-02T03:04:05.123456", "2026-01-02T03:04:05.123456"},
	}
	for _, c := range cases {
		if got := Bind(c.engine, NewColumn("c", c.driverType), sp(c.store)); got != c.want {
			t.Errorf("Bind(%s %s, %q) = %#v, want %#v", c.engine, c.driverType, c.store, got, c.want)
		}
	}
	// SQL Server reads a varchar key by its index only when the value is varchar too.
	if got := Bind("sqlserver", NewColumn("permit_no", "VARCHAR"), sp("BP-1")); got != mssql.VarChar("BP-1") {
		t.Errorf("an ASCII value of a varchar column binds as varchar: %#v", got)
	}
	if got := Bind("sqlserver", NewColumn("name", "VARCHAR"), sp("résumé")); got != "résumé" {
		t.Errorf("other text stays nvarchar: %#v", got)
	}
	if got := Bind("sqlserver", NewColumn("name", "NVARCHAR"), sp("BP-1")); got != "BP-1" {
		t.Errorf("an nvarchar column's value stays nvarchar: %#v", got)
	}
	for _, v := range []string{"2026-01-02 10:00:00+02", "2026-01-02 10:00:00+0200", "2026-01-02T10:00:00+02"} {
		if !Same("postgres", NewColumn("at", "TIMESTAMPTZ"), sp(v), sp("2026-01-02T08:00:00Z")) {
			t.Errorf("%q is the moment 2026-01-02T08:00:00Z", v)
		}
	}
}

// Oracle's INSERT ALL names at most 999 columns between its INTO clauses; one row is a plain INSERT.
func TestOracleInsertsStayWithinItsColumnLimit(t *testing.T) {
	for _, c := range []struct{ columns, most, want int }{{10, 500, 99}, {3, 500, 100}, {500, 500, 1}, {1000, 5, 1}} {
		if got := RowsPerInsert("oracle", c.columns, c.most); got != c.want || (got > 1 && got*c.columns > 999) {
			t.Errorf("RowsPerInsert(oracle, %d columns) = %d, want %d", c.columns, got, c.want)
		}
	}
	one := InsertRows("oracle", "OWNER", "PERMITS", []Column{NewColumn("PERMIT_NO", "VARCHAR2")}, 1)
	if !strings.HasPrefix(one, `INSERT INTO "OWNER"."PERMITS"`) {
		t.Errorf("one row: %s", one)
	}
}

func TestPushStatementsInEachDialect(t *testing.T) {
	cols := []Column{NewColumn("town", "INT"), NewColumn("permit no", "VARCHAR"), NewColumn("fee", "DECIMAL")}
	key := []int{0, 1}
	want := map[string][3]string{
		"mysql": {
			"SELECT `town`, `permit no`, `fee` FROM `t`.`p` WHERE (`town`, `permit no`) IN ((?, ?), (?, ?)) FOR UPDATE /* push:rows */",
			"INSERT INTO `t`.`p` (`town`, `permit no`, `fee`) VALUES (?, ?, ?), (?, ?, ?) /* push:insert */",
			"UPDATE `t`.`p` SET `fee` = ? WHERE `town` = ? AND `permit no` = ? /* push:update */",
		},
		"postgres": {
			`SELECT "town", "permit no", "fee" FROM "t"."p" WHERE ("town", "permit no") IN (($1, $2), ($3, $4)) FOR UPDATE /* push:rows */`,
			`INSERT INTO "t"."p" ("town", "permit no", "fee") VALUES ($1, $2, $3), ($4, $5, $6) /* push:insert */`,
			`UPDATE "t"."p" SET "fee" = $1 WHERE "town" = $2 AND "permit no" = $3 /* push:update */`,
		},
		"sqlserver": {
			"SELECT [town], [permit no], [fee] FROM [t].[p] WITH (UPDLOCK, HOLDLOCK) WHERE (([town] = @p1 AND [permit no] = @p2) OR ([town] = @p3 AND [permit no] = @p4)) /* push:rows */",
			"INSERT INTO [t].[p] ([town], [permit no], [fee]) VALUES (@p1, @p2, @p3), (@p4, @p5, @p6) /* push:insert */",
			"UPDATE [t].[p] SET [fee] = @p1 WHERE [town] = @p2 AND [permit no] = @p3 /* push:update */",
		},
		"oracle": {
			`SELECT "town", "permit no", "fee" FROM "t"."p" WHERE ("town", "permit no") IN ((:1, :2), (:3, :4)) FOR UPDATE /* push:rows */`,
			`INSERT ALL INTO "t"."p" ("town", "permit no", "fee") VALUES (:1, :2, :3) INTO "t"."p" ("town", "permit no", "fee") VALUES (:4, :5, :6) SELECT 1 FROM DUAL /* push:insert */`,
			`UPDATE "t"."p" SET "fee" = :1 WHERE "town" = :2 AND "permit no" = :3 /* push:update */`,
		},
	}
	for eng, w := range want {
		if got := SelectByKeys(eng, "t", "p", cols, key, 2, true); got != w[0] {
			t.Errorf("%s select:\n got %s\nwant %s", eng, got, w[0])
		}
		if got := InsertRows(eng, "t", "p", cols, 2); got != w[1] {
			t.Errorf("%s insert:\n got %s\nwant %s", eng, got, w[1])
		}
		if got := UpdateRow(eng, "t", "p", cols, []int{2}, key); got != w[2] {
			t.Errorf("%s update:\n got %s\nwant %s", eng, got, w[2])
		}
	}
	if got := SelectByKeys("mysql", "t", "p", cols, []int{1}, 3, false); got != "SELECT `town`, `permit no`, `fee` FROM `t`.`p` WHERE `permit no` IN (?, ?, ?) /* push:rows */" {
		t.Errorf("an unlocked read of a one-column key: %s", got)
	}
	if got := DeleteByKeys("sqlserver", "t", "p", cols, []int{1}, 2); got != "DELETE FROM [t].[p] WHERE [permit no] IN (@p1, @p2) /* push:delete */" {
		t.Errorf("a delete: %s", got)
	}
	// Oracle reads its numbers as text, so no digit of a key is lost.
	if got := SelectByKeys("oracle", "t", "p", []Column{NewColumn("id", "NUMBER")}, []int{0}, 1, false); !strings.Contains(got, `TO_CHAR("id", 'TM9'`) {
		t.Errorf("Oracle's numbers: %s", got)
	}
	// A link's table is read by value: the distinct values of one column among those asked.
	for eng, want := range map[string]string{
		"mysql":     "SELECT DISTINCT `parcel id` FROM `t`.`p` WHERE `parcel id` IN (?, ?) /* push:links */",
		"postgres":  `SELECT DISTINCT "parcel id" FROM "t"."p" WHERE "parcel id" IN ($1, $2) /* push:links */`,
		"sqlserver": "SELECT DISTINCT [parcel id] FROM [t].[p] WHERE [parcel id] IN (@p1, @p2) /* push:links */",
		"oracle":    `SELECT DISTINCT "parcel id" FROM "t"."p" WHERE "parcel id" IN (:1, :2) /* push:links */`,
	} {
		if got := SelectDistinctIn(eng, "t", "p", NewColumn("parcel id", "VARCHAR"), 2); got != want {
			t.Errorf("%s links:\n got %s\nwant %s", eng, got, want)
		}
	}
	if got := SelectDistinctIn("oracle", "t", "p", NewColumn("ward", "NUMBER"), 1); !strings.HasPrefix(got, `SELECT DISTINCT TO_CHAR("ward", 'TM9'`) || !strings.Contains(got, `WHERE "ward" IN (:1)`) {
		t.Errorf("Oracle's numbers in a link: %s", got)
	}
	// SQL Server binds at most 2,000 parameters, Oracle a list of 1,000.
	if KeysPerRead("sqlserver", 5, 500) != 400 || KeysPerRead("oracle", 1, 5000) != 1000 || KeysPerRead("mysql", 2, 500) != 500 {
		t.Errorf("keys per read: %d %d %d", KeysPerRead("sqlserver", 5, 500), KeysPerRead("oracle", 1, 5000), KeysPerRead("mysql", 2, 500))
	}
	if RowsPerInsert("sqlserver", 3, 500) != 500 || RowsPerInsert("oracle", 3, 500) != 100 || RowsPerInsert("sqlserver", 30, 500) != 66 {
		t.Errorf("rows per insert: %d %d %d", RowsPerInsert("sqlserver", 3, 500), RowsPerInsert("oracle", 3, 500), RowsPerInsert("sqlserver", 30, 500))
	}
}

// A value that does not read as its column's kind is held by no row of the column, so a read by value
// never binds it, where the database would refuse the statement.
func TestReadableIsAValueOfTheColumnsKind(t *testing.T) {
	for _, c := range []struct {
		column Column
		value  string
		want   bool
	}{
		{NewColumn("parcel_id", "VARCHAR"), "anything at all", true},
		{NewColumn("parcel_id", "CHAR"), "P-1  ", true},
		{NewColumn("scan", "BLOB"), `\x00ff`, true},
		{NewColumn("ward", "INT"), "07", true},
		{NewColumn("ward", "INT"), "1.0e1", true},
		{NewColumn("ward", "INT"), "x", false},
		{NewColumn("issued_on", "DATE"), "2026-01-02", true},
		{NewColumn("issued_on", "DATE"), "next tuesday", false},
		{NewColumn("open", "BOOL"), "yes", true},
		{NewColumn("open", "BOOL"), "maybe", false},
		// A uuid column takes only a GUID; an integer column only a whole number within its range; NaN
		// and Infinity only a Postgres column of fractions.
		{NewColumn("owner", "UUID"), "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", true},
		{NewColumn("owner", "UUID"), "{A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}", true},
		{NewColumn("owner", "UUID"), "N/A", false},
		{NewColumn("ward", "INT4"), "1.5", false},
		{NewColumn("ward", "INT4"), "2147483647", true},
		{NewColumn("ward", "INT4"), "2147483648", false},
		{NewColumn("ward", "INT2"), "-32769", false},
		{NewColumn("ward", "INT8"), "9223372036854775807", true},
		{NewColumn("ward", "INT"), "NaN", false},
		{NewColumn("fee", "NUMERIC"), "1.5", true},
		{NewColumn("fee", "FLOAT8"), "NaN", true},
	} {
		if got := Readable("postgres", c.column, c.value); got != c.want {
			t.Errorf("Readable(%s %s, %q) = %t, want %t", c.column.Name, c.column.Type, c.value, got, c.want)
		}
	}
	for _, c := range []struct {
		engine string
		column Column
		value  string
		want   bool
	}{
		{"sqlserver", NewColumn("badge", "UNIQUEIDENTIFIER"), "6F9619FF-8B86-D011-B42D-00C04FC964FF", true},
		{"sqlserver", NewColumn("badge", "UNIQUEIDENTIFIER"), "B-1", false},
		{"sqlserver", NewColumn("level", "TINYINT"), "255", true},
		{"mysql", NewColumn("level", "TINYINT"), "255", false},
		{"mysql", NewColumn("level", "UNSIGNED TINYINT"), "255", true},
		{"mysql", NewColumn("fee", "DOUBLE"), "NaN", false},
	} {
		if got := Readable(c.engine, c.column, c.value); got != c.want {
			t.Errorf("Readable(%s: %s %s, %q) = %t, want %t", c.engine, c.column.Name, c.column.Type, c.value, got, c.want)
		}
	}
}
