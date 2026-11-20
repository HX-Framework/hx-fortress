# The store's suite of tests, for any host

A store runs on a host: its SQLite, its transactions, its alarm, its bookmarks and its files.
On Cloudflare the host is a Durable Object and R2. Another host gives a store the same things on a
SQLite file and a folder of a disk. This suite holds a host to what a store needs, so that a store
behaves the same wherever it runs.

The tests are the `*.suite.ts` files beside the code they test, under `src/`. They are ordinary
test files, with two differences: `describe` and `it` come from `host.ts`, and a new store's
storage comes from `host()`.

## Running it on a host

1. Write a `StoreHost` (`host.ts`). It makes a new, empty store's storage, and says what it holds.
2. Bind it and the test runner, in a module of its own:

   ```ts
   // bind.ts
   import { describe, it } from "node:test"; // or the runner the host's tests use
   import { bindSuite } from "./suite/host.js";
   import { myHost } from "./my-host.js";

   bindSuite(myHost, {
     describe: (name, fn) => void describe(name, fn),
     it: (name, fn) => void it(name, fn),
     skip: (name, why) => void it.skip(`${name} (${why})`, () => undefined),
   });
   ```

3. Import the binding first and the suite second:

   ```ts
   // store.test.ts
   import "./bind.js";
   import "./suite/all.js"; // every suite file, or one of them
   ```

## What a host hands in

| Member | What it is |
| --- | --- |
| `storage()` | A new, empty store's storage: what a store itself is handed (`StoreStorage` in `src/core.ts`), with a few members a test reads beside it (`HostStorage`). |
| `database(bytes?)` | A database of the host's own SQLite, apart from every store. A test opens an export's file with it. |
| `state(storage)` | Optional. The state a store gets around its storage. Left out, the suite's stand-in is used. |
| `files()` | Optional. A bucket for a store's files (`StoreFiles` in `src/store-files.ts`). Left out, the suite keeps files in memory. |
| `traits` | Where the host differs from Cloudflare on purpose. A test that needs a trait is listed as skipped on a host without it, with the reason. |
| `reach` | Rule 1: how the host keeps a statement inside its own store's file. |
| `runaway` | Rule 2: how the host stops a statement that never ends. |

The suite runs a store's alarm by hand (`store.alarm()`), so a host under test never fires one by
itself.

**A host refuses a statement in SQLite's words, with the result code's name at the end**, as
workerd does: `not authorized: SQLITE_AUTH`, `no such table: permits: SQLITE_ERROR`. A store reads
a failure with `SQLITE_` in it as the statement's own and answers 400 `sql_error`; any other
failure it answers as its own, 500 `internal`. Rule 1's tests of a store's own calls fail on a
host whose refusal a store cannot read so.

## The two rules

`src/host-rules.suite.ts` tests them, and says how a store on Cloudflare passes each.

**Rule 1. A statement reaches only its own store's file.** A host that holds the rule itself gives
the suite a second SQLite file (`reach.otherFile()`), and the suite tries to reach it: `ATTACH` in
seven spellings, as a second statement, `VACUUM INTO`, an extension, and PRAGMAs outside the short
list a store runs. After each try it reads the other file again, and checks that no new file
appeared. `REACH_ATTACKS` is the list.

**Rule 2. A statement that never ends is stopped, and the host still answers.** A host that holds
the rule itself opens stores the way it runs them (`runaway.open()`): apart from its own loop. The
suite starts a statement that never ends in one, asks another store meanwhile, waits for the host
to stop the statement, and reads the first store again.

A worker thread does not hold rule 2. Tried on 2026-11-15, on Node 26.4 and on Bun 1.3.14: a worker
that is inside a SQLite statement goes on after `terminate()`. A process does: the kill signal
ends it in a few milliseconds, and SQLite rolls the unfinished statement back when the file is
opened again. `testing/apart-process.ts` is the stand-in's version of that.

## Traits

| Trait | A host says true when | Without it |
| --- | --- | --- |
| `billedWrites` | It counts the rows a statement wrote as Cloudflare bills them: a row's entry in an index is a row. | The checks of an exact billed count are left out. A store's daily write limit counts SQLite's own number. |
| `limits.*` | It refuses what is past one of workerd's six limits on SQLite, in SQLite's words. | The test of that limit is skipped. A store keeps its own caps under these limits, so it behaves the same. |
| `bookmarks` | It keeps moments of the database to go back to. | The tests of a restore are skipped, and a store answers `restore_unavailable`. |

A host is held to every trait it claims: `src/host-rules.suite.ts`, "what a host says of itself".

## Sample files

LOAD's tests read sample files (`store-readers/fixtures/`). A test whose sample file is missing is
listed as skipped, with the file's name: a copy of this suite made for another repository holds
only the samples that are text, because every file of such a copy is read before it is written.

## The stand-ins

`testing/fakes.ts` is the host this repository's own test run uses: Node's SQLite with workerd's
limits, its count of written rows and its authorizer. `STORE_SUITE_HOST` runs the suite on a
stand-in that differs from workerd in one way (`testing/on-stand-ins.ts`):

| Value | The stand-in | What the suite does |
| --- | --- | --- |
| `plain-writes` | counts rows as SQLite does | passes, with the billed counts left out |
| `no-bookmarks` | keeps no bookmarks | passes, with the restore tests skipped |
| `no-limits` | holds none of workerd's limits | passes, with the limit tests skipped |
| `no-guard` | runs `ATTACH` and every PRAGMA | fails rule 1: 19 statements, and all five of a store's doors |
