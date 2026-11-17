# The data runner, for its caller

The data runner is a program that does one job on a database and answers one output. The database
is SQL Server, Oracle, MySQL or Postgres. A caller starts the program once for each job, hands it
the job, and reads the output. This page is everything a caller relies on.

This build reaches a database straight at the host and port a job names. It starts no other
program and makes no request to any service of its own.

## The command

```
data-runner run --job-stdin
```

- The job is one JSON object on standard input. Write it, then close standard input. It holds at
  most 1 MiB. If standard input is not closed within 30 seconds, the program answers `internal` and
  exits.
- `data-runner run`, with no flag, reads the job from the environment variable `DATA_JOB` and
  clears the variable before it does anything else. Prefer standard input: on Linux a process's
  first environment stays readable in `/proc/<pid>/environ` to its own user for as long as it runs,
  and the job holds a login. A pipe is seen by nobody else. A job given both ways is refused.
- `data-runner version` prints the build's version.
- One process does one job, then exits. Each job opens one session on the database, except a
  `query` with `onlyOpenable`, which then opens each database its rows name (below).
- The program needs no file, no folder it can write to, and no root rights.

## The job

An unknown field is refused, except inside `params`, where the program reads `sql`, `limit` and
`onlyOpenable` and ignores the rest. An example:

```json
{
  "v": 1,
  "id": "job_0001",
  "kind": "query",
  "engine": "sqlserver",
  "database": "Permits",
  "server": { "host": "sql01.northstar.example", "port": 1433 },
  "tls": { "mode": "verify", "minVersion": "1.2" },
  "reach": { "kind": "direct", "host": "sql01.northstar.example", "port": 1433 },
  "login": { "kind": "read", "user": "permits_reader", "password": "example-password" },
  "deadline": "2026-11-14T18:32:00Z",
  "params": { "sql": "SELECT TOP 3 permit_no, address, type, issued FROM permits ORDER BY issued", "limit": 3 }
}
```

| Field | What it is |
| --- | --- |
| `v` | `1` |
| `id` | the job's id, 1 to 64 characters. It comes back in the output |
| `kind` | `test`, `query`, `pull`, `compare` or `push` |
| `engine` | `sqlserver`, `oracle`, `mysql` or `postgres` |
| `database` | the database's name, 1 to 256 characters (for Oracle, the service name) |
| `server` | the server's host and port. TLS checks the certificate against this host, unless `tls.serverName` names another. For SQL Server, `.` and `(local)` are read as `localhost` |
| `tls.mode` | `verify` (check the certificate), `require` (encrypt, check nothing), `off`, or `strict` (SQL Server's TDS 8 only) |
| `tls.minVersion` | `"1.0"`, `"1.1"`, `"1.2"` or `"1.3"` |
| `tls.serverName` | optional: the name the certificate must carry when it is not the server's host |
| `tls.caCertificate` | optional: a certificate authority in PEM, at most 20,000 characters. It takes the place of the machine's authorities |
| `reach` | `{ "kind": "direct", "host", "port" }`: where the program dials. The same host and port as `server` |
| `login` | `kind` is `read` or `write`, which of a connection's two logins this is; `user`; `password` (at most 1,024 characters). A `push` runs with the write login |
| `deadline` | an RFC 3339 instant with an offset (`Z` or `+01:00`) |
| `catalogMaxTables` | optional, for a `test`: 1 to 100,000 tables. 5,000 when left out |
| `params` | for a `query`: `sql` (one statement, at most 20,000 characters), optional `limit` (1 to 200 rows; 200 when left out), and optional `onlyOpenable` (true or false; below) |
| `store` | for a `pull`, `compare` or `push`: `gatewayUrl`, `storeId`, `jobId`, `key` |

The job's shape has more things, which this build refuses: a `reach` of the kind `access` or
`public` (`not_ready`), and a `country` on a direct job (`internal`). They belong to the ways a
hosted runner reaches a database, through a tunnel or across the internet, which this build does
not hold.

The login's user and password are in the job and nowhere else. The program keeps them in memory
and never writes them to a file. It never prints the password, and takes it out of every message it
answers. The user is a name: a database's refusal may repeat it.

### What a `query`'s statement must be

Before it opens anything, the program reads the statement's text and refuses one that is not a
single statement that only reads (`database`, with a sentence that says what to write instead).
It reads the text the way the job's `engine` reads it:

- With quoted text and comments taken out, the statement starts with SELECT or WITH, is one
  statement, and holds no word that writes as a word of its own: INTO, INSERT, UPDATE, DELETE,
  MERGE, TRUNCATE, DROP, ALTER, CREATE, GRANT, REVOKE, DENY, EXEC, EXECUTE, COMMIT, ROLLBACK,
  BACKUP, RESTORE, DBCC, KILL, SHUTDOWN, RECONFIGURE, OPENROWSET, OPENDATASOURCE, OPENQUERY. A
  column of such a name is written in quotes.
- On SQL Server a second statement needs no semicolon, so the words that start one there are
  refused too: DECLARE, SET, USE, BEGIN, IF, WHILE, WAITFOR, PRINT, OPEN, CLOSE and the others SQL
  Server reserves for a statement of their own. On MySQL, LOCK is refused.
- A quote is what the engine says it is. `[name]` quotes a name on SQL Server only, a backtick on
  MySQL only, and `$$text$$` is quoted text on PostgreSQL only.
- An at sign (`@`) is part of a name on SQL Server, and on MySQL it starts a variable. On
  PostgreSQL it is an operator and on Oracle it starts a database link's name, so there a word
  ends at it: in `a@delete` the check reads DELETE.
- What two engines could read differently is refused, never guessed at: `#` outside quotes, `--`
  with no space after it, a backslash before a quote inside quoted text, a comment MySQL would run
  (`/*! ... */`), a `/*` inside a comment, Oracle's `q'[...]'`, SQL Server's `{call ...}`, a
  `$1` parameter on PostgreSQL, a control character other than a tab or a line end, a letter
  outside a to z that stands outside quotes, a number that runs into a word that writes
  (`1e1DELETE`), a number whose exponent has no digits (`1.5e`, `1.5e-`: MySQL reads the
  character after such a number as a token of its own, so a `--` right after it is no comment
  there), and a quote, a bracket or a comment that is never closed.
- Two more on MySQL, where a job can also reach a MariaDB server. A bracket outside quotes: MySQL
  reads it as no part of a statement, and MariaDB 10.4.5 and later read `[name]` as a quoted name
  when the server's `sql_mode` holds MSSQL. And a `$` that starts a word: MySQL 8.1 and later read
  `$$` or `$tag$` there as the start of quoted text, which only a stored program's body may hold.
  Write such a name in backticks. Inside a name a `$` is part of it, as in `v$session`, and so it
  is after an integer (`1$x` is a name). After a number with a decimal point or an exponent
  (`1.5`, `1e1`) a `$` starts a word: MySQL ends such a number whatever follows, so it is refused.

`contract/vectors/query-refusal.json` holds the cases: each statement, the engines it is read on,
whether it is refused, and why. A caller that checks a statement itself before it starts the
program reads the same file, so the two refuse the same statements.

**A statement that holds a character outside ASCII is also held to the database's character set.**
The check above reads the text as it is written, and takes such a character inside quoted text and
comments. Two engines can read another character in its place:

- On Oracle the program writes a statement in the database's own character set. For a set other
  than AL32UTF8 or UTF8, a character outside ASCII is rewritten to fit, and some become an ASCII
  character that looks alike: in WE8MSWIN1252 the modifier apostrophe (U+02BC) is written as `'`.
  Quoted text would then end earlier for Oracle than for the check.
- On MySQL a server can be set to read a statement in another character set than the UTF-8 the
  program asks for.

So for such a statement the program first asks the database which character set it reads a
statement in (`NLS_CHARACTERSET` on Oracle, `@@character_set_client` on MySQL). When the answer
is not Unicode, the job fails as `database` and nothing of the statement is sent. The sentence
names the character set and says how to write the character: `UNISTR('Jos\00e9')` on Oracle,
`CHAR(0xC3A9 USING utf8mb4)` on MySQL. A statement of ASCII characters alone asks nothing, and SQL
Server and PostgreSQL read every character as written. This check needs the database, so a
caller's own scan of the text cannot make it.

This check reads the text only. What keeps a query from changing a database is the login the job
names, and the transaction the statement runs in: read-only on PostgreSQL, MySQL and Oracle, and
rolled back on every engine. SQL Server has no read-only transaction, so give a query a login that
can only read. The text cannot show a function that does more than read, or a statement that holds
a lock for as long as it runs (a table hint on SQL Server, `FOR SHARE` on MySQL). On SQL Server it
cannot show a second SELECT, or a second statement that starts with a word SQL Server does not
reserve, or with END or FETCH, which a SELECT uses itself. The login's rights and the deadline
bound each.

### A query that lists databases: `onlyOpenable`

A statement can read which databases a login may connect to by privilege, but not every rule the
server keeps: PostgreSQL's `pg_hba.conf` can refuse a database the login holds `CONNECT` on, and
the login cannot read that file. With `"onlyOpenable": true` in `params`, each row names a database
in its first value, and the program opens each of them the way it opened the job's own: the same
server, TLS and login. It answers only the rows whose database the server let the login open.

- The job's own database is not opened again. A row with no database in it is left out.
- A database the server refused (an access rule, a missing privilege, no database of that name) is
  left out. A database whose open failed for another reason stays: a full server or a broken path
  says nothing about the database.
- The program closes the job's own session first, then opens at most four databases at a time and
  closes each at once. The step ends 20 seconds after it began; a database it has not opened by then
  stays in the answer.
- PostgreSQL, MySQL and SQL Server only. An Oracle job reaches the one service it names, so a
  `query` on Oracle with `onlyOpenable` true is refused.

## The output

Standard output holds one line: the output, one JSON object. The program prints nothing else
there. Read standard output to its end and parse the last line.

```json
{ "v": 1, "id": "job_0001", "ok": true, "where": null,
  "result": { "kind": "query",
    "columns": [ { "name": "permit_no", "type": "nvarchar" }, { "name": "issued", "type": "date" } ],
    "rows": [ ["BP-2026-0412", "2026-03-02"], ["BP-2026-0413", null] ],
    "truncated": false,
    "ms": { "tunnel": 0, "connect": 31, "query": 4, "total": 52 } },
  "ms": 53 }
```

```json
{ "v": 1, "id": "job_0001", "ok": false, "where": null,
  "error": { "code": "login", "message": "The database refused the login." },
  "ms": 120 }
```

- `ok` true comes with `result` and no `error`. `ok` false comes with `error` and no `result`.
- `id` is the job's id. It is empty when the job could not be read at all.
- `where` is always `null` in this build.
- **A query's rows are in the output and nowhere else.** A query's standard output is rows: a
  caller never logs it. Every value is text or `null`. A value is cut at 1,000 characters and the
  rows together at 1 MB of JSON; `truncated` says a cut happened or more rows exist.
- A `test` answers names and counts: the server's version, how the connection was encrypted, what
  the login may change, and the catalog (tables, columns, types, keys, row estimates). Never a row.
  The catalog is cut to the tables whose JSON fits in 6 MiB (`catalog.truncated`).
- A `pull`, `compare` or `push` answers counts. Its rows go to the store's gateway.
- Standard error holds progress lines that start with `data-runner: `. They hold no login, no key
  and no row. They are for a person to read.
- When the environment variable `DATA_RUNNER_STAGES` names a file, the program appends one line
  there as it starts each step: `data-runner stage {"stage":"connect","try":1}`, then for a test
  `data-runner stage {"stage":"catalog"}`.

`error.code`:

| Code | Means |
| --- | --- |
| `unreachable` | the server did not answer, refused the connection, closed it, or sent it on to another address |
| `tls` | the certificate was refused, or TLS failed. The message says what the certificate names, what the connection expects and who signed it |
| `login` | the database refused the login |
| `database` | the database answered an error, or a `query`'s statement is not one statement that only reads (above) |
| `deadline` | the deadline passed, or the process was told to stop |
| `store`, `store_limit` | the store's gateway refused a call, or the store reached its daily write limit |
| `not_ready` | this build does not run that job |
| `internal` | the job could not be read, or the fault is the program's own |

`error.message` is one sentence for a person. It can quote the database's own words and a table's
or a column's name.

## Exit codes

| Exit code | Means |
| --- | --- |
| 0 | an output was printed. The job may still have failed: read `ok` |
| 1 | no output: standard output was closed |
| 2 | no output: the command line was wrong, or the program crashed. Go exits 2 on a panic and on a fatal error of its runtime, such as a `GOMEMLIMIT` it cannot read |

Any exit code but 0, and a process killed by a signal, printed no output.

## The deadline, and a stop

- At `deadline` the program stops whatever it is doing and answers `deadline`, with exit code 0.
  It reads the machine's own clock.
- SIGTERM or SIGINT stops it the same way, at once, whatever the engine, and also while it still
  waits for its job on standard input.
- A caller kills a process that is still there 15 seconds after the deadline or the stop. Nothing
  needs cleaning up after it: a query runs in a transaction that is rolled back, and a `push`
  commits batch by batch.

## What it opens on the network

1. Connections to `reach.host` and `reach.port`, one session at a time. A `query` with
   `onlyOpenable` then closes that session and opens up to four at a time, on the same host and
   port, one for each database its rows name. The machine's own resolver looks the host up. A server that sends the login on to another address is refused
   (`unreachable`, with the fix in the message). Azure SQL does that in its Redirect connection
   policy, and so do an Oracle SCAN listener and a shared server's dispatcher.
2. For a `pull`, `compare` or `push` only: HTTP requests to the origin of `store.gatewayUrl`. They
   honour `HTTPS_PROXY` and `NO_PROXY`. A redirect is refused, never followed.

Nothing else. With `tls.mode` `verify` and no `tls.caCertificate`, the certificate's chain is
checked against the machine's own authorities. On Linux those are the files under `/etc/ssl/certs`
(or what `SSL_CERT_FILE` and `SSL_CERT_DIR` name); an image without them fails every such check as
`tls`. On macOS that check is Apple's own, which may fetch a certificate or a revocation answer
itself.

## What it reads from its environment

| Variable | Use |
| --- | --- |
| `DATA_JOB` | the job, when it is not on standard input |
| `DATA_RUNNER_STAGES` | the file for step lines. Optional |
| `GOMEMLIMIT` | how much memory the program aims to stay under, in Go's units: `512MiB`, `2GiB`. `512MB` is not one of them, and the program then exits 2 before it reads its job. Without the variable: 160 MiB, and 3 GiB for a `pull` |
| `HTTPS_PROXY`, `NO_PROXY` | for calls to the store's gateway only |
| `SSL_CERT_FILE`, `SSL_CERT_DIR` | where Linux finds certificate authorities |

The program's libraries read three more when they are set: `HTTP_PROXY` (for a gateway at an
`http://` address), `MSSQL_USE_EPA` (the SQL Server driver's extended protection for
authentication) and `USER` (the Oracle driver tells the server the client's user name).

A caller gives the process only these, never its own environment. The program also removes every
`PG*` variable from its own environment before it connects, because its Postgres driver reads them.

## What a `pull`, `compare` or `push` needs from a store's gateway

- A base URL in `store.gatewayUrl`. `http://127.0.0.1:<port>` works, and so does HTTPS.
- Every call carries `Authorization: Bearer <store.key>`. The key is for one store job.
- A pull's routes, under `{gatewayUrl}/v1/stores/{storeId}/jobs/{jobId}/pull`: `GET`,
  `POST /begin`, `POST /hashes`, `POST /page`, `POST /end`, `POST /fail`.
- A push's, a preview's and a compare's routes, under `…/jobs/{jobId}/rows`: `GET`, `POST /begin`,
  `POST /read`, `POST /send`, `POST /end`, `POST /fail`.
- Bodies and answers are JSON. `contract/pull/` and `contract/push/` hold one example of each.
- A refusal is a status of 400 or more with `{ "error": "<words>", "code": "<code>" }`. The
  program knows two codes: `job_key_refused` and `write_limit_reached`.
- A call is tried up to 6 times when the network fails or the answer is a 5xx, and each try waits
  at most 90 seconds. A page has a number, and a page sent twice must be taken once.

## Building it

```
go build -o data-runner .
go test ./...
```

One file with nothing to install beside it, for Linux and macOS on amd64 and arm64. The Linux file
is statically linked with `CGO_ENABLED=0`; the macOS file links the system's own libraries, as
every Go program does.

The tests start no container and need no database server: a listener stands in for one. The tests
whose names end in `ForReal` are skipped unless a variable `DATA_RUNNER_IT_<ENGINE>` names a server
of that engine with an admin's login. They then make a database and logins of their own there, run
real jobs, and drop what they made. Never name a server whose data matters.
