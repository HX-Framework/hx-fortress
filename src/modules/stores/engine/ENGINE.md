# The Store's engine

These files are a Store's engine: its tables, queries, jobs, history and daily write limit, and
the readers of the files a Store loads. The engine runs on a host that gives a Store its SQLite,
its transactions, its alarm and its files.

**A script writes this folder. Nobody changes a file here by hand.** The engine is developed in
another repository. `engine-files.json` lists every file of this folder with its size and its SHA-256,
so a check that computes them again finds a file that was changed, added or removed here.

- Written from commit `0056878b26fa` of that repository, committed 2026-11-21T00:23:26+03:00. `engine-files.json` has the commit in full.
- `store-object/src/` is the engine. Its tests are the `*.suite.ts` files beside the code, written
  for any host: `store-object/testing/suite/README.md` says how a host runs them.
- `store-readers/src/` reads the files a Store loads. It imports these packages: `fflate` 0.8.3, `fzstd` 0.1.1, `hyparquet` 1.31.5, `mdb-reader` 3.2.0, `xlsx` 0.20.3 (that repository keeps it as a file).
- `store-readers/fixtures/` holds the sample files the engine's tests read, where they are text.
  A test whose sample file is not here is listed as skipped.

## Left out

| Files | Why |
| --- | --- |
| 11 | A sample file that is not text, so its bytes cannot be checked |
| 42 | A sample file that no test in this folder reads |
| 10 | A script that makes the sample files |
| 4 | A stand-in on Node's SQLite, for that repository's own test run |
| 22 | A test file that binds the suite to the stand-ins of the repository the engine is developed in |
| 24 | One of the readers' own tests, which run on another test runner |
| 9 | That repository's packaging |
| 1 | The Durable Object class, which needs Cloudflare's runtime |

`engine-files.json` names each one.

## Before a file is written

The script reads every file it would write, and writes nothing when one of them:

- names a customer;
- holds something that looks like a secret;
- holds an address that is neither an example's nor a public reference's;
- names a vendor, or claims an audit attestation;
- is not text;
- imports a file that is not in this folder.
