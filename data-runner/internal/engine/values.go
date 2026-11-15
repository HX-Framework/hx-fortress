package engine

// Comparing a store's value with a database's, for a push and a compare, and turning a store's value
// into what a write binds. A store keeps a value as SQLite gave it back as text ("175", "175.0", a
// date as "2026-01-02"); the database answers it in its own one form (rows.go: "175.00" for a
// decimal(10,2), "2026-01-02 00:00:00" for a datetime). Two values are the same when the database's
// column would hold the same thing for both: equal numbers for a number's column, the same moment for
// a time's, the same text for text. A value the runner cannot read as the column's kind is compared as
// text, so it is never taken for a value it is not.

import (
	"encoding/hex"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	mssql "github.com/microsoft/go-mssqldb"
)

// Family is what kind of value a column holds, as a comparison reads it.
type Family int

const (
	// FamilyText compares text as it is.
	FamilyText Family = iota
	// FamilyChar is fixed-width text: trailing spaces do not count.
	FamilyChar
	// FamilyNumber compares numbers by value: "175" and "175.00" are the same. "true" and "false" read
	// as 1 and 0, as a database that keeps a yes or no in a small integer holds them.
	FamilyNumber
	// FamilyBool compares yes or no.
	FamilyBool
	// FamilyBits is MySQL's BIT: bytes that hold a number.
	FamilyBits
	// FamilyDate is a day.
	FamilyDate
	// FamilyDateTime is a moment with no zone, as a wall clock reads it.
	FamilyDateTime
	// FamilyDateTimeZone is a moment in time, whatever zone it is written in.
	FamilyDateTimeZone
	// FamilyTime is a time of day.
	FamilyTime
	// FamilyBinary is bytes, which a store keeps as \x and hex.
	FamilyBinary
)

// FamilyOf is the kind of value a column of this engine holds, from its driver's type name.
func FamilyOf(engine string, c Column) Family {
	base := c.base
	switch base {
	case "INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT", "INT2", "INT4", "INT8", "YEAR",
		"UNSIGNED INT", "UNSIGNED BIGINT", "UNSIGNED SMALLINT", "UNSIGNED TINYINT", "UNSIGNED MEDIUMINT",
		"DECIMAL", "NUMERIC", "NUMBER", "MONEY", "SMALLMONEY", "FLOAT", "DOUBLE", "REAL", "FLOAT4", "FLOAT8",
		"BINARY_FLOAT", "BINARY_DOUBLE", "IBFLOAT", "IBDOUBLE", "DOUBLE PRECISION", "DEC", "FIXED", "UNSIGNED DECIMAL",
		"UNSIGNED DOUBLE", "UNSIGNED FLOAT":
		return FamilyNumber
	case "BOOL", "BOOLEAN":
		return FamilyBool
	case "BIT":
		if engine == "mysql" {
			return FamilyBits
		}
		// SQL Server's bit is a yes or no; go-mssqldb answers it as a bool.
		return FamilyBool
	case "DATE":
		if engine == "oracle" {
			// Oracle's DATE holds a time of day too.
			return FamilyDateTime
		}
		return FamilyDate
	case "DATETIME", "DATETIME2", "SMALLDATETIME", "TIMESTAMP", "TIMESTAMPDTY", "TIMESTAMP_DTY":
		// MySQL's TIMESTAMP is kept in UTC and answered in the session's zone with no zone named, so as
		// text it reads as a wall clock too.
		return FamilyDateTime
	case "TIME":
		return FamilyTime
	case "CHAR", "NCHAR", "BPCHAR":
		return FamilyChar
	}
	if zoned(base) {
		return FamilyDateTimeZone
	}
	if binaryType(base) {
		return FamilyBinary
	}
	return FamilyText
}

// Same says whether a store's value and the database's are the same for this column: both NULL, the
// same text, or the same value read as the column's kind.
func Same(engine string, c Column, store, db *string) bool {
	if store == nil || db == nil {
		return store == nil && db == nil
	}
	if *store == *db {
		return true
	}
	a, aok := canon(FamilyOf(engine, c), *store)
	b, bok := canon(FamilyOf(engine, c), *db)
	return aok && bok && a == b
}

// Readable says a store's value reads as the column's kind, so a statement can bind it there: any
// value in a column of text or bytes, but only a GUID in a uuid's; a number in a number's, but only a
// whole one within its range in an integer's, and NaN or Infinity only in a Postgres column of
// fractions, which keeps them; a moment in a time's. No row of the column holds a value that does not,
// so a read never needs to ask for one: the database would refuse the whole statement.
func Readable(engine string, c Column, v string) bool {
	switch f := FamilyOf(engine, c); f {
	case FamilyText, FamilyChar:
		if c.base == "UUID" || c.base == "UNIQUEIDENTIFIER" {
			return guid.MatchString(strings.TrimSpace(v))
		}
		return true
	case FamilyBinary:
		return true
	case FamilyNumber:
		s, ok := number(v)
		if !ok {
			return false
		}
		lo, hi, whole := integerRange(engine, c.base)
		switch s {
		case "nan", "infinity", "-infinity", "inf", "-inf", "+inf":
			return engine == "postgres" && !whole
		}
		if !whole {
			return true
		}
		r, ok := new(big.Rat).SetString(s)
		return ok && r.IsInt() && r.Num().Cmp(lo) >= 0 && r.Num().Cmp(hi) <= 0
	default:
		_, ok := canon(f, v)
		return ok
	}
}

// guid is a GUID as uuid and uniqueidentifier columns read it: 8-4-4-4-12 hex digits, braced or not.
var guid = regexp.MustCompile(`^\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?$`)

// integerRange is the range of an integer column's values, by its driver's type name; whole false for
// a column that is not one of whole numbers.
func integerRange(engine, base string) (lo, hi *big.Int, whole bool) {
	unsigned := strings.HasPrefix(base, "UNSIGNED ")
	bits := 0
	switch strings.TrimPrefix(base, "UNSIGNED ") {
	case "TINYINT":
		if engine == "sqlserver" {
			// SQL Server's tinyint holds 0 to 255.
			return big.NewInt(0), big.NewInt(255), true
		}
		bits = 8
	case "SMALLINT", "INT2":
		bits = 16
	case "MEDIUMINT":
		bits = 24
	case "INT", "INTEGER", "INT4":
		bits = 32
	case "BIGINT", "INT8":
		bits = 64
	case "YEAR":
		// MySQL's YEAR holds 1901 to 2155, or 0.
		return big.NewInt(0), big.NewInt(2155), true
	default:
		return nil, nil, false
	}
	one := big.NewInt(1)
	if unsigned {
		return big.NewInt(0), new(big.Int).Sub(new(big.Int).Lsh(one, uint(bits)), one), true
	}
	limit := new(big.Int).Lsh(one, uint(bits-1))
	return new(big.Int).Neg(limit), new(big.Int).Sub(limit, one), true
}

// CanonKey is a row's key as the column kinds read it, for finding the database's row of a store's
// key: "0042" and "42" name the same row of an integer key. Text stays as it is.
func CanonKey(engine string, columns []Column, values []*string, key []int) string {
	var b strings.Builder
	for i, at := range key {
		if i > 0 {
			b.WriteByte(0)
		}
		v := values[at]
		if v == nil {
			b.WriteString("\x01null")
			continue
		}
		if c, ok := canon(FamilyOf(engine, columns[at]), *v); ok {
			b.WriteString(c)
		} else {
			b.WriteString(*v)
		}
	}
	return b.String()
}

// FoldKey is CanonKey without regard to case, for a database whose key's collation ignores it.
func FoldKey(engine string, columns []Column, values []*string, key []int) string {
	return strings.ToLower(CanonKey(engine, columns, values, key))
}

// canon is a value's one form for its kind, or ok false when it cannot be read as one.
func canon(f Family, v string) (string, bool) {
	switch f {
	case FamilyChar:
		return strings.TrimRight(v, " "), true
	case FamilyNumber:
		return number(v)
	case FamilyBool:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "true", "t", "1", "yes", "y":
			return "1", true
		case "false", "f", "0", "no", "n":
			return "0", true
		}
		return "", false
	case FamilyBits:
		if n, ok := bitsNumber(v); ok {
			return strconv.FormatUint(n, 10), true
		}
		return "", false
	case FamilyDate:
		if t, ok := moment(v); ok && t.Hour() == 0 && t.Minute() == 0 && t.Second() == 0 && t.Nanosecond() == 0 {
			return t.Format("2006-01-02"), true
		}
		return "", false
	case FamilyDateTime:
		if t, ok := moment(v); ok {
			return t.Format("2006-01-02 15:04:05.999999999"), true
		}
		return "", false
	case FamilyDateTimeZone:
		if t, ok := moment(v); ok {
			return t.UTC().Format(time.RFC3339Nano), true
		}
		return "", false
	case FamilyTime:
		for _, layout := range []string{"15:04:05.999999999", "15:04"} {
			if t, err := time.Parse(layout, strings.TrimSpace(v)); err == nil {
				return t.Format("15:04:05.999999999"), true
			}
		}
		return "", false
	}
	return "", false
}

// number is a number's one form: its exact value as a fraction, so "175", "175.0", "1.75e2" and
// "+175.00" are one number. true and false are 1 and 0.
func number(v string) (string, bool) {
	s := strings.TrimSpace(v)
	switch strings.ToLower(s) {
	case "true":
		return "1", true
	case "false":
		return "0", true
	case "nan", "infinity", "-infinity", "inf", "-inf", "+inf":
		return strings.ToLower(s), true
	}
	r, ok := ratOf(s)
	if !ok {
		return "", false
	}
	return r.RatString(), true
}

// A number in decimal digits, with an exponent of at most three digits.
var decimalNumber = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?(\d{1,3}))?$`)

// ratOf reads a number written in decimal digits, with or without an exponent, exactly. Nothing
// else is one (a fraction, a hex float), and neither is an exponent past 400, whose value would take
// more digits than any database's number column holds, and more memory than a job has to spare.
func ratOf(s string) (*big.Rat, bool) {
	if len(s) > 400 {
		return nil, false
	}
	m := decimalNumber.FindStringSubmatch(s)
	if m == nil {
		return nil, false
	}
	if exp, _ := strconv.Atoi(m[1]); exp > 400 {
		return nil, false
	}
	return new(big.Rat).SetString(s)
}

// plainNumber is a number in plain decimal digits, exactly: "176.0" is "176", "1.75e2" is "175" and
// "1.0e-05" is "0.00001". Every database reads these in every number's column, where Postgres and
// SQL Server refuse "176.0" in an integer's and an exponent in a decimal's. A value with no plain
// decimal form (a fraction such as 1/3) is not one.
func plainNumber(v string) (string, bool) {
	r, ok := ratOf(strings.TrimSpace(v))
	if !ok {
		return "", false
	}
	if r.IsInt() {
		return r.Num().String(), true
	}
	// A decimal fraction's denominator is 2^a·5^b; it needs max(a, b) digits after the point.
	d := new(big.Int).Set(r.Denom())
	twos, fives := 0, 0
	for d.Bit(0) == 0 {
		d.Rsh(d, 1)
		twos++
	}
	five, rest := big.NewInt(5), new(big.Int)
	for {
		q, m := new(big.Int).QuoRem(d, five, rest)
		if m.Sign() != 0 {
			break
		}
		d = q
		fives++
	}
	if d.Cmp(big.NewInt(1)) != 0 {
		return "", false
	}
	return r.FloatString(max(twos, fives)), true
}

// bitsNumber reads MySQL's BIT as a number: from its bytes as a store keeps them (\x and hex), or
// from a number written out.
func bitsNumber(v string) (uint64, bool) {
	s := strings.TrimSpace(v)
	if strings.HasPrefix(s, `\x`) {
		raw, err := hex.DecodeString(s[2:])
		if err != nil || len(raw) > 8 {
			return 0, false
		}
		var n uint64
		for _, b := range raw {
			n = n<<8 | uint64(b)
		}
		return n, true
	}
	switch strings.ToLower(s) {
	case "true":
		return 1, true
	case "false":
		return 0, true
	}
	n, err := strconv.ParseUint(s, 10, 64)
	return n, err == nil
}

// The ways a moment is written: a store's SQL (SQLite's datetime()), ISO 8601, the forms rows.go
// answers, and Postgres's own text, whose zone may name only its hours ("+02") or have no colon.
var momentLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999",
	"2006-01-02 15:04:05.999999999Z07:00",
	"2006-01-02 15:04:05.999999999 -07:00",
	"2006-01-02 15:04:05.999999999Z07",
	"2006-01-02T15:04:05.999999999Z07",
	"2006-01-02 15:04:05.999999999Z0700",
	"2006-01-02T15:04:05.999999999Z0700",
	"2006-01-02 15:04:05.999999999",
	"2006-01-02T15:04",
	"2006-01-02 15:04",
	"2006-01-02",
}

// moment reads a date or a moment. One with no zone is read as UTC, so two such values compare by
// their wall clocks.
func moment(v string) (time.Time, bool) {
	s := strings.TrimSpace(v)
	for _, layout := range momentLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// Bind is a store's value as a write binds it for this column: as it is, except where the database
// would refuse or misread its text. A number binds its plain decimal digits and a yes or no for a
// number's column 1 or 0; MySQL's BIT and every binary column bind bytes; a moment is written the way
// the engine reads it whatever its session's language or zone says.
func Bind(engine string, c Column, v *string) any {
	if v == nil {
		return nil
	}
	s := *v
	f := FamilyOf(engine, c)
	switch f {
	case FamilyNumber:
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "true":
			return "1"
		case "false":
			return "0"
		}
		// A store keeps a number as SQLite wrote it ("212.0", "1.0e-05"), where Postgres and SQL
		// Server read only plain digits for some columns.
		if n, ok := plainNumber(s); ok {
			return n
		}
		return strings.TrimSpace(s)
	case FamilyBool:
		if engine == "postgres" {
			return s
		}
		if n, ok := canon(f, s); ok {
			return n
		}
		return s
	case FamilyBits:
		if n, ok := bitsNumber(s); ok {
			return int64(n)
		}
		return s
	case FamilyBinary:
		if strings.HasPrefix(s, `\x`) {
			if raw, err := hex.DecodeString(s[2:]); err == nil {
				if engine == "postgres" {
					// pgx sends text in Postgres's own text form, where \x and hex is bytea's.
					return s
				}
				return raw
			}
		}
		return []byte(s)
	case FamilyDate, FamilyDateTime, FamilyDateTimeZone:
		t, ok := moment(s)
		if !ok {
			return s
		}
		return momentBind(engine, c, f, t, s)
	}
	if !utf8.ValidString(s) {
		return strings.ToValidUTF8(s, "�")
	}
	// go-mssqldb sends a Go string as nvarchar. Against a varchar column under a SQL collation, SQL
	// Server converts the column instead of the value, so a read by key scans the table and, under a
	// write's locks, holds every row it read. Text of ASCII alone is the same in every code page, so
	// it goes as varchar; other text stays nvarchar, which SQL Server reads right, only slower.
	if engine == "sqlserver" && (c.base == "VARCHAR" || c.base == "CHAR") && ascii(s) {
		return mssql.VarChar(s)
	}
	return s
}

func ascii(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// momentBind writes a moment the way each engine reads text into a date or a time, whatever the
// session's language or zone: SQL Server's datetime reads only `2006-01-02T15:04:05` the same in every
// language, and at most three digits of a second's fraction; Oracle reads text by the session's
// formats, which each data job's session sets (OracleSession); Postgres reads a moment with no zone
// in the session's zone, where Same reads it as UTC.
func momentBind(engine string, c Column, f Family, t time.Time, s string) any {
	switch engine {
	case "sqlserver":
		switch {
		case f == FamilyDate:
			return t.Format("2006-01-02")
		case f == FamilyDateTimeZone:
			return t.Format("2006-01-02T15:04:05.9999999Z07:00")
		case c.base == "DATETIME":
			return t.Round(time.Millisecond).Format("2006-01-02T15:04:05.999")
		case c.base == "SMALLDATETIME":
			return t.Round(time.Second).Format("2006-01-02T15:04:05")
		}
		return t.Format("2006-01-02T15:04:05.9999999")
	case "postgres":
		if f == FamilyDateTimeZone {
			return t.UTC().Format(time.RFC3339Nano)
		}
		return s
	case "oracle":
		switch {
		case c.base == "DATE":
			return t.Format("2006-01-02 15:04:05")
		case f == FamilyDateTimeZone:
			return t.Format("2006-01-02 15:04:05.000000000 -07:00")
		}
		return t.Format("2006-01-02 15:04:05.000000000")
	case "mysql":
		if f == FamilyDateTimeZone {
			return t.UTC().Format("2006-01-02 15:04:05.999999")
		}
		if f == FamilyDate {
			return t.Format("2006-01-02")
		}
		return t.Format("2006-01-02 15:04:05.999999")
	}
	return s
}

// OracleSession sets what an Oracle session reads text into a date, a time and a number by: the forms
// Bind writes. A push's, a preview's and a compare's session sets it before it binds a value, in one
// round trip.
const OracleSession = `ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'` +
	` NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'` +
	` NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'` +
	` NLS_NUMERIC_CHARACTERS = '.,'`

// TooLongToWrite says a store's value is the name a pull gave a binary value too long to keep
// (rows.go's `[binary, N bytes, sha256 …]`), which no write can turn back into its bytes.
func TooLongToWrite(engine string, c Column, v *string) bool {
	return v != nil && FamilyOf(engine, c) == FamilyBinary && strings.HasPrefix(*v, "[binary, ")
}
