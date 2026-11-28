// A Modern App's statements and people, on a store's object: an app's statements answer in
// drizzle sqlite-proxy's shapes, a batch is one transaction, the schema and the store's own tables
// are out of an app's reach (but `_users`, which it reads), and exec and migrate never touch the
// user tables. Signing in follows the join rule and each stage's "who opens it"; a removed person
// and an ended or expired session open nothing.

import { describe, it, host, stateOf, filesOf, itRestores } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import type { AppSignInBody, AppStatementResult, StoreCaller, StoreResult } from "./types.js";

const A = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const APP: StoreCaller = { storeId: A, actor: "app:app_00000000000000000000000000000001--staging" };
const DEPLOYER: StoreCaller = { storeId: A, actor: "user:u-deployer" };
const ISSUER = "https://id.example.test";

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map() };
  const make = () => new StoreHandler(state as never, { FILES: r2.asBucket() }, deps);
  return { clock, storage, state, make, store: make() };
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function refusal<T>(result: StoreResult<T>): { status: number; code: string; error: string } {
  assert.equal(result.ok, false, "expected a refusal");
  return result as { status: number; code: string; error: string };
}

/** A store with the app's own tables, made the way a release's migration makes them. */
async function withLoans() {
  const s = setup();
  value(
    await s.store.migrate(DEPLOYER, {
      id: "0000_first_tables",
      sql: `CREATE TABLE \`laptops\` (\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL, \`tag\` text NOT NULL, \`spare\` integer DEFAULT false NOT NULL, \`photo\` blob);
--> statement-breakpoint
CREATE TABLE \`loans\` (\`id\` integer PRIMARY KEY NOT NULL, \`laptop_id\` integer NOT NULL REFERENCES \`laptops\`(\`id\`), \`borrower\` text NOT NULL);`,
    }),
  );
  return s;
}

describe("an app's statements", () => {
  it("answer in drizzle sqlite-proxy's shapes: run, all, values and get", async () => {
    const { store } = await withLoans();
    const run = value(await store.appQuery(APP, { sql: 'insert into "laptops" ("tag", "spare") values (?, ?)', params: ["LT-1", true], method: "run" }));
    assert.deepEqual(run, { rows: [], changes: 1, lastInsertRowid: 1 });
    value(await store.appQuery(APP, { sql: 'insert into "laptops" ("tag", "spare") values (?, ?)', params: ["LT-2", false], method: "run" }));
    const all = value(await store.appQuery(APP, { sql: 'select "id", "tag", "spare" from "laptops" order by "id"', params: [], method: "all" }));
    assert.deepEqual(all.rows, [
      [1, "LT-1", 1],
      [2, "LT-2", 0],
    ]);
    const values = value(await store.appQuery(APP, { sql: 'select "tag" from "laptops"', params: [], method: "values" }));
    assert.deepEqual(values.rows, [["LT-1"], ["LT-2"]]);
    const get = value(await store.appQuery(APP, { sql: 'select "tag" from "laptops" where "id" = ?', params: [2], method: "get" }));
    assert.deepEqual(get.rows, ["LT-2"]);
    // drizzle reads a truthy empty array as a row, so none is nothing at all.
    const none = value(await store.appQuery(APP, { sql: 'select "tag" from "laptops" where "id" = ?', params: [99], method: "get" }));
    assert.equal(none.rows, undefined);
    // A write that returns: its rows and the rows it changed.
    const returned = value(await store.appQuery(APP, { sql: 'update "laptops" set "spare" = 1 where "id" = ? returning "id"', params: [2], method: "get" }));
    assert.deepEqual(returned, { rows: [2], changes: 1 });
    // A read sent as run changed nothing, and says nothing about rows or row ids.
    assert.deepEqual(value(await store.appQuery(APP, { sql: 'select count(*) from "laptops"', params: [], method: "run" })), { rows: [] });
  });

  it("bind booleans, bigints and bytes the way drizzle sends them", async () => {
    const { store } = await withLoans();
    value(await store.appQuery(APP, { sql: "insert into laptops (tag, spare, photo) values (?, ?, ?)", params: ["LT-9", false, new Uint8Array([1, 2, 3])], method: "run" }));
    const row = value(await store.appQuery(APP, { sql: "select length(photo), spare, ? + 1 from laptops", params: [41n], method: "get" })).rows as unknown[];
    assert.deepEqual(row, [3, 0, 42]);
    assert.equal(refusal(await store.appQuery(APP, { sql: "select ?", params: [{ a: 1 }], method: "all" })).code, "bad_request");
    assert.equal(refusal(await store.appQuery(APP, { sql: "select ?", params: [Number.NaN], method: "all" })).code, "bad_request");
  });

  it("run a batch in one transaction: all of it, or none of it", async () => {
    const { store } = await withLoans();
    const results = value(
      await store.appBatch(APP, [
        { sql: "insert into laptops (tag) values (?)", params: ["LT-1"], method: "run" },
        { sql: "insert into loans (id, laptop_id, borrower) values (?, ?, ?)", params: [1, 1, "sam@acme.test"], method: "run" },
        { sql: "select count(*) from loans", params: [], method: "get" },
      ]),
    ) as AppStatementResult[];
    assert.equal(results.length, 3);
    assert.deepEqual(results[2]!.rows, [1]);
    // The second statement breaks the loan's key: the first one's laptop never lands either.
    const failed = await store.appBatch(APP, [
      { sql: "insert into laptops (tag) values (?)", params: ["LT-2"], method: "run" },
      { sql: "insert into loans (id, laptop_id, borrower) values (?, ?, ?)", params: [1, 1, "again@acme.test"], method: "run" },
    ]);
    assert.equal(refusal(failed).code, "sql_error");
    const count = value(await store.appQuery(APP, { sql: "select count(*) from laptops", params: [], method: "get" }));
    assert.deepEqual(count.rows, [1]);
  });

  it("never change the schema: it comes from the app's migrations", async () => {
    const { store } = await withLoans();
    for (const sql of ["create table extra (id integer)", "drop table loans", "alter table laptops add column color text", "create index laptops_tag on laptops (tag)"]) {
      const refused = refusal(await store.appQuery(APP, { sql, params: [], method: "run" }));
      assert.equal(refused.code, "bad_request", sql);
      assert.match(refused.error, /schema comes from the app's repository/, sql);
    }
  });

  it("send no BEGIN, COMMIT or PRAGMA, and say to batch instead", async () => {
    const { store } = await withLoans();
    for (const sql of ["begin", "commit", "savepoint sp1", "rollback"]) {
      assert.match(refusal(await store.appQuery(APP, { sql, params: [], method: "run" })).error, /db\.batch/, sql);
    }
    assert.match(refusal(await store.appQuery(APP, { sql: "pragma foreign_keys = off", params: [], method: "run" })).error, /no PRAGMA/);
    assert.equal(refusal(await store.appQuery(APP, { sql: "select 1; select 2", params: [], method: "all" })).code, "bad_request");
    assert.equal(refusal(await store.appQuery(APP, { sql: "vacuum", params: [], method: "run" })).code, "bad_request");
  });

  it("read _users, but never write it, nor read or write the store's other tables", async () => {
    const { store } = await withLoans();
    value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Borrower" }));
    const listed = value(await store.appQuery(APP, { sql: "select email, role from _users", params: [], method: "all" }));
    assert.deepEqual(listed.rows, [["sam@acme.test", "Borrower"]]);
    for (const sql of [
      "update _users set role = 'Owner'",
      "delete from _sessions",
      "insert into _meta (key, value) values ('x', 'y')",
      "update __drizzle_migrations set hash = 'x'",
    ]) {
      assert.equal(refusal(await store.appQuery(APP, { sql, params: [], method: "run" })).code, "protected_table", sql);
    }
    for (const sql of ["select value from _meta", "select * from _sessions", "select sql from _migrations", "select name from sqlite_master", "select * from laptops join _meta on 1 = 1"]) {
      assert.equal(refusal(await store.appQuery(APP, { sql, params: [], method: "all" })).code, "protected_table", sql);
    }
  });

  it("write a program's tables never, and read them", async () => {
    const { store, storage } = await withLoans();
    storage.sql.exec("CREATE TABLE permits (id INTEGER, town TEXT)");
    storage.sql.exec("INSERT INTO permits VALUES (1, 'Example County')");
    storage.sql.exec("INSERT INTO _tables (name, kind, version, created_at, updated_at) VALUES ('permits', 'program', 1, 'now', 'now')");
    assert.deepEqual(value(await store.appQuery(APP, { sql: "select town from permits", params: [], method: "get" })).rows, ["Example County"]);
    assert.equal(refusal(await store.appQuery(APP, { sql: "delete from permits", params: [], method: "run" })).code, "protected_table");
  });

  it("leave a written table's row count to be counted again", async () => {
    const { store, storage } = await withLoans();
    value(await store.stats(DEPLOYER));
    assert.equal(storage.sql.exec<{ rows: number | null }>("SELECT rows FROM _tables WHERE name = 'laptops'").one().rows, 0);
    value(await store.appQuery(APP, { sql: "insert into laptops (tag) values ('LT-1')", params: [], method: "run" }));
    assert.equal(storage.sql.exec<{ rows: number | null }>("SELECT rows FROM _tables WHERE name = 'laptops'").one().rows, null);
    assert.equal(value(await store.stats(DEPLOYER)).rows, 1);
  });
});

describe("exec and migrate keep away from the user tables", () => {
  it("refuse writing, dropping or changing _users and _sessions", async () => {
    const { store } = await withLoans();
    for (const sql of ["INSERT INTO _users (id, email, role, status, created_at) VALUES ('usr_1', 'a@b.example', 'x', 'active', 'now')", "DELETE FROM _sessions", "DROP TABLE _users", "ALTER TABLE _users ADD COLUMN x TEXT"]) {
      assert.equal(refusal(await store.exec(DEPLOYER, { sql })).code, "protected_table", sql);
    }
    assert.equal(refusal(await store.migrate(DEPLOYER, { id: "0001_users", sql: "ALTER TABLE _users ADD COLUMN nickname TEXT" })).code, "protected_table");
    assert.equal(refusal(await store.migrate(DEPLOYER, { id: "0002_sessions", sql: "CREATE INDEX s ON _sessions (expires_at)" })).code, "protected_table");
  });

  it("refuse a virtual table whose module would read them, so an app never reads them through one", async () => {
    const { store } = await withLoans();
    for (const [id, sql] of [
      ["0001_mirror", "CREATE VIRTUAL TABLE mirror USING fts5(id, user_id, content='_sessions')"],
      ["0002_meta", "CREATE VIRTUAL TABLE meta_text USING fts5(key, value, content='_meta')"],
    ] as const) {
      assert.equal(refusal(await store.migrate(DEPLOYER, { id, sql })).code, "protected_table", sql);
    }
    // A virtual table over the app's own table is the app's to have.
    value(await store.migrate(DEPLOYER, { id: "0003_search", sql: "CREATE VIRTUAL TABLE laptop_search USING fts5(tag, content='laptops', content_rowid='id')" }));
  });

  it("list both as quiet system tables", async () => {
    const { store } = await withLoans();
    const tables = value(await store.catalog(DEPLOYER)).tables;
    for (const name of ["_users", "_sessions"]) {
      const t = tables.find((x) => x.name === name);
      assert.ok(t, name);
      assert.equal(t.kind, "system");
      assert.equal(t.quiet, true);
    }
  });
});

const SESSION_1 = "1".repeat(64);
const SESSION_2 = "2".repeat(64);

function signIn(over: Partial<AppSignInBody> & { email?: string; sub?: string; verified?: boolean } = {}): AppSignInBody {
  return {
    identity: { issuer: ISSUER, sub: over.sub ?? "sub-sam", email: over.email ?? "sam@acme.test", emailVerified: over.verified ?? true, name: "Sam Okafor" },
    whoOpens: over.whoOpens ?? "users",
    join: over.join ?? { mode: "invited", domains: [] },
    defaultRole: over.defaultRole ?? "Borrower",
    authorRole: over.authorRole ?? "Owner",
    author: over.author ?? false,
    session: over.session ?? { id: SESSION_1, days: 14 },
  };
}

describe("signing in to a stage", () => {
  it("refuses someone not invited, then lets them in once invited, by their verified email", async () => {
    const { store } = setup();
    assert.deepEqual(value(await store.appSignIn(APP, signIn())), { ok: false, reason: "not_invited", user: null });
    const invited = value(await store.appUserInvite(DEPLOYER, { email: "Sam@Acme.test", role: "Admin", tester: true })).user;
    assert.equal(invited.email, "sam@acme.test");
    assert.equal(invited.status, "invited");
    assert.equal(invited.invitedBy, "user:u-deployer");
    const signedIn = value(await store.appSignIn(APP, signIn()));
    assert.equal(signedIn.ok, true);
    if (!signedIn.ok) return;
    assert.equal(signedIn.user.id, invited.id);
    assert.equal(signedIn.user.status, "active");
    assert.equal(signedIn.user.role, "Admin");
    assert.equal(signedIn.user.issuer, ISSUER);
    assert.equal(signedIn.user.sub, "sub-sam");
    assert.equal(signedIn.user.emailVerified, true);
    // A second sign-in finds them by issuer and subject, whatever their email does.
    const again = value(await store.appSignIn(APP, signIn({ session: { id: SESSION_2, days: 14 } })));
    assert.equal(again.ok && again.user.id, invited.id);
  });

  it("never links an invite to an email the issuer does not vouch for, or to another sign-in's", async () => {
    const { store } = setup();
    value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Admin" }));
    assert.deepEqual(value(await store.appSignIn(APP, signIn({ verified: false }))), { ok: false, reason: "email_unverified", user: null });
    assert.equal(value(await store.appSignIn(APP, signIn())).ok, true);
    // Someone else, at another issuer account, with the same email.
    assert.deepEqual(value(await store.appSignIn(APP, signIn({ sub: "sub-other", session: { id: SESSION_2, days: 14 } }))), { ok: false, reason: "email_in_use", user: null });
  });

  it("lets people at a listed domain join with the default role, and nobody else", async () => {
    const { store } = setup();
    const join = { mode: "domains" as const, domains: ["acme.test"] };
    const joined = value(await store.appSignIn(APP, signIn({ join })));
    assert.equal(joined.ok && joined.user.role, "Borrower");
    assert.equal(joined.ok && joined.user.author, false);
    assert.deepEqual(value(await store.appSignIn(APP, signIn({ join, email: "lee@other.test", sub: "sub-lee", session: { id: SESSION_2, days: 14 } }))), {
      ok: false,
      reason: "domain_not_listed",
      user: null,
    });
    // Anyone with the link.
    const open = value(await store.appSignIn(APP, signIn({ join: { mode: "link", domains: [] }, email: "lee@other.test", sub: "sub-lee", session: { id: SESSION_2, days: 14 } })));
    assert.equal(open.ok, true);
  });

  it("opens an authors' stage to authors only, with a row marked for them", async () => {
    const { store } = setup();
    assert.deepEqual(value(await store.appSignIn(APP, signIn({ whoOpens: "authors" }))), { ok: false, reason: "authors_only", user: null });
    const author = value(await store.appSignIn(APP, signIn({ whoOpens: "authors", author: true })));
    assert.equal(author.ok, true);
    if (!author.ok) return;
    assert.equal(author.user.author, true);
    assert.equal(author.user.role, "Owner");
    // Their row opens nothing once they are no author, on any stage.
    const session = value(await store.appSession(APP, { id: SESSION_1, whoOpens: "authors" }));
    assert.deepEqual(session.ok && session.opens, { asAuthor: true, asOther: false });
    const onUsersStage = value(await store.appSession(APP, { id: SESSION_1, whoOpens: "users" }));
    assert.deepEqual(onUsersStage.ok && onUsersStage.opens, { asAuthor: true, asOther: false });
    // Once they are no author, signing in to a stage its users open goes by the list like anyone's.
    const later = value(await store.appSignIn(APP, signIn({ whoOpens: "users", author: false, session: { id: SESSION_2, days: 14 } })));
    assert.equal(!later.ok && later.reason, "not_invited");
  });

  it("opens an authors' and testers' stage to listed testers, and refuses the rest of the list", async () => {
    const { store } = setup();
    value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Borrower", tester: true }));
    value(await store.appUserInvite(DEPLOYER, { email: "lee@acme.test", role: "Borrower" }));
    const tester = value(await store.appSignIn(APP, signIn({ whoOpens: "authors-testers" })));
    assert.equal(tester.ok, true);
    const other = value(await store.appSignIn(APP, signIn({ whoOpens: "authors-testers", email: "lee@acme.test", sub: "sub-lee", session: { id: SESSION_2, days: 14 } })));
    assert.equal(other.ok, false);
    assert.equal(!other.ok && other.reason, "testers_only");
  });

  it("changes nothing on the list when the stage refuses the person", async () => {
    const { store } = setup();
    value(await store.appUserInvite(DEPLOYER, { email: "lee@acme.test", role: "Borrower" }));
    const refused = value(await store.appSignIn(APP, signIn({ whoOpens: "authors-testers", email: "lee@acme.test", sub: "sub-lee" })));
    assert.equal(!refused.ok && refused.reason, "testers_only");
    const lee = value(await store.appUsers(DEPLOYER)).users[0]!;
    assert.equal(lee.status, "invited");
    assert.equal(lee.sub, null);
    assert.deepEqual(value(await store.appSession(APP, { id: SESSION_1, whoOpens: "authors-testers" })), { ok: false, reason: "no_session" });
  });

  it("moves a person's email only to one their issuer vouches for and nobody else holds", async () => {
    const { store } = setup();
    value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Borrower" }));
    value(await store.appSignIn(APP, signIn()));
    // The same sign-in, now claiming the boss's address without the issuer vouching for it.
    const claimed = value(await store.appSignIn(APP, signIn({ email: "boss@acme.test", verified: false, session: { id: SESSION_2, days: 14 } })));
    assert.equal(claimed.ok && claimed.user.email, "sam@acme.test");
    assert.equal(value(await store.appUserInvite(DEPLOYER, { email: "boss@acme.test", role: "Admin" })).user.status, "invited");
    // Vouched for, and held by someone else: it stays as it was.
    const third = value(await store.appSignIn(APP, signIn({ email: "boss@acme.test", verified: true, session: { id: "3".repeat(64), days: 14 } })));
    assert.equal(third.ok && third.user.email, "sam@acme.test");
    // Vouched for and free: it follows.
    const moved = value(await store.appSignIn(APP, signIn({ email: "sam.okafor@acme.test", verified: true, session: { id: "4".repeat(64), days: 14 } })));
    assert.equal(moved.ok && moved.user.email, "sam.okafor@acme.test");
  });

  it("lets an author onto a users' stage they are not listed on, with the app's first role", async () => {
    const { store } = setup();
    const author = value(await store.appSignIn(APP, signIn({ whoOpens: "users", author: true })));
    assert.equal(author.ok, true);
    if (!author.ok) return;
    assert.equal(author.user.author, true);
    assert.equal(author.user.role, "Owner");
  });

  it("keeps the role the list gives an author, and keeps someone removed out", async () => {
    const { store } = setup();
    const invited = value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Borrower" }));
    const listed = value(await store.appSignIn(APP, signIn({ whoOpens: "users", author: true })));
    assert.equal(listed.ok && listed.user.role, "Borrower");
    assert.equal(listed.ok && listed.user.author, false);
    value(await store.appUserUpdate(DEPLOYER, invited.user.id, { status: "removed" }));
    const removed = value(await store.appSignIn(APP, signIn({ whoOpens: "users", author: true, session: { id: SESSION_2, days: 14 } })));
    assert.equal(!removed.ok && removed.reason, "removed");
  });
});

describe("a session, on every request", () => {
  it("names the person and whether they open the stage; ends when they sign out or are removed", async () => {
    const { store } = setup();
    const invited = value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Admin" })).user;
    value(await store.appSignIn(APP, signIn()));
    value(await store.appSignIn(APP, signIn({ session: { id: SESSION_2, days: 14 } })));
    const read = value(await store.appSession(APP, { id: SESSION_1, whoOpens: "users" }));
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok && read.opens, { asAuthor: true, asOther: true });
    assert.equal(read.ok && read.user.id, invited.id);
    // This browser signs out; the other one still works.
    assert.deepEqual(value(await store.appSessionEnd(APP, { id: SESSION_1 })), { ended: true });
    assert.deepEqual(value(await store.appSession(APP, { id: SESSION_1, whoOpens: "users" })), { ok: false, reason: "ended" });
    assert.equal(value(await store.appSession(APP, { id: SESSION_2, whoOpens: "users" })).ok, true);
    // Removed: the next request opens nothing, and signing in again is refused.
    const removed = value(await store.appUserUpdate(DEPLOYER, invited.id, { status: "removed" })).user;
    assert.equal(removed.status, "removed");
    assert.deepEqual(value(await store.appSession(APP, { id: SESSION_2, whoOpens: "users" })), { ok: false, reason: "ended" });
    const refused = value(await store.appSignIn(APP, signIn({ session: { id: "3".repeat(64), days: 14 } })));
    assert.equal(!refused.ok && refused.reason, "removed");
  });

  it("expires after the stage's session length, and answers nothing for an unknown id", async () => {
    const { store, clock } = setup();
    value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Admin" }));
    value(await store.appSignIn(APP, signIn({ session: { id: SESSION_1, days: 1 } })));
    assert.equal(value(await store.appSession(APP, { id: SESSION_1, whoOpens: "users" })).ok, true);
    clock.advance(24 * 60 * 60_000 + 1);
    assert.deepEqual(value(await store.appSession(APP, { id: SESSION_1, whoOpens: "users" })), { ok: false, reason: "expired" });
    assert.deepEqual(value(await store.appSession(APP, { id: "f".repeat(64), whoOpens: "users" })), { ok: false, reason: "no_session" });
    assert.deepEqual(value(await store.appSession(APP, { id: "not-a-hash", whoOpens: "users" })), { ok: false, reason: "no_session" });
  });

  it("marks when someone was last seen, at most every few minutes", async () => {
    const { store, clock, storage } = setup();
    value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Admin" }));
    value(await store.appSignIn(APP, signIn()));
    const seen = () => storage.sql.exec<{ last_seen_at: string }>("SELECT last_seen_at FROM _users").one().last_seen_at;
    const first = seen();
    clock.advance(60_000);
    value(await store.appSession(APP, { id: SESSION_1, whoOpens: "users" }));
    assert.equal(seen(), first);
    clock.advance(5 * 60_000);
    value(await store.appSession(APP, { id: SESSION_1, whoOpens: "users" }));
    assert.notEqual(seen(), first);
  });
});

describe("a native client's token, on every request", () => {
  it("finds the person by the token's issuer and sub, with what they may open, and makes no session", async () => {
    const { store } = setup();
    value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Borrower" }));
    // Before their first web sign-in the list has no issuer or sub for them: a token finds nobody.
    assert.deepEqual(value(await store.appTokenUser(APP, { issuer: ISSUER, sub: "sub-sam", whoOpens: "users" })), { ok: false, reason: "not_listed" });
    assert.equal(value(await store.appSignIn(APP, signIn())).ok, true);
    const found = value(await store.appTokenUser(APP, { issuer: ISSUER, sub: "sub-sam", whoOpens: "users" }));
    assert.equal(found.ok, true);
    if (!found.ok) return;
    assert.equal(found.user.email, "sam@acme.test");
    assert.deepEqual(found.opens, { asAuthor: true, asOther: true });
    // Another issuer's subject with the same sub is somebody else.
    assert.deepEqual(value(await store.appTokenUser(APP, { issuer: "https://other.example/oidc", sub: "sub-sam", whoOpens: "users" })), { ok: false, reason: "not_listed" });
  });

  it("refuses a removed person, and opens an authors' stage by the same rule as a session", async () => {
    const { store } = setup();
    const author = value(await store.appSignIn(APP, signIn({ whoOpens: "authors", author: true })));
    assert.equal(author.ok, true);
    const onAuthors = value(await store.appTokenUser(APP, { issuer: ISSUER, sub: "sub-sam", whoOpens: "authors" }));
    assert.deepEqual(onAuthors.ok && onAuthors.opens, { asAuthor: true, asOther: false });
    const onUsers = value(await store.appTokenUser(APP, { issuer: ISSUER, sub: "sub-sam", whoOpens: "users" }));
    assert.deepEqual(onUsers.ok && onUsers.opens, { asAuthor: true, asOther: false }, "an author's row opens a users stage only while they are an author");
    const sam = value(await store.appUsers(DEPLOYER)).users[0]!;
    value(await store.appUserUpdate(DEPLOYER, sam.id, { status: "removed" }));
    assert.deepEqual(value(await store.appTokenUser(APP, { issuer: ISSUER, sub: "sub-sam", whoOpens: "authors" })), { ok: false, reason: "removed" });
    assert.equal(refusal(await store.appTokenUser(APP, { issuer: ISSUER, sub: "sub-sam", whoOpens: "everyone" })).status, 400);
  });
});

describe("the user list", () => {
  it("invites, changes roles and testers, signs out everywhere, removes and brings back", async () => {
    const { store } = setup();
    const sam = value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Borrower", name: "Sam" })).user;
    assert.equal(refusal(await store.appUserInvite(DEPLOYER, { email: "SAM@acme.test", role: "Admin" })).code, "app_user_exists");
    assert.equal(refusal(await store.appUserInvite(DEPLOYER, { email: "not an email", role: "Admin" })).code, "bad_request");
    assert.equal(refusal(await store.appUserInvite(DEPLOYER, { email: "lee@acme.test", role: "" })).code, "bad_request");
    const changed = value(await store.appUserUpdate(DEPLOYER, sam.id, { role: "Admin", tester: true })).user;
    assert.equal(changed.role, "Admin");
    assert.equal(changed.tester, true);
    value(await store.appSignIn(APP, signIn()));
    value(await store.appSignIn(APP, signIn({ session: { id: SESSION_2, days: 14 } })));
    assert.deepEqual(value(await store.appUserSignOut(DEPLOYER, sam.id)), { ended: 2 });
    assert.deepEqual(value(await store.appSession(APP, { id: SESSION_1, whoOpens: "users" })), { ok: false, reason: "ended" });
    value(await store.appUserUpdate(DEPLOYER, sam.id, { status: "removed" }));
    // Invited again: they had signed in before, so they are active at once.
    const back = value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Borrower" })).user;
    assert.equal(back.id, sam.id);
    assert.equal(back.status, "active");
    assert.equal(back.removedAt, null);
    assert.equal(refusal(await store.appUserUpdate(DEPLOYER, "usr_000000000000000000000000", { role: "Admin" })).code, "app_user_not_found");
    assert.deepEqual(
      value(await store.appUsers(DEPLOYER)).users.map((u) => [u.email, u.role, u.status]),
      [["sam@acme.test", "Borrower", "active"]],
    );
  });

  it("signs out the person a sign-in names, of the sessions that started before a time", async () => {
    const { store, clock } = setup();
    value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Borrower" }));
    value(await store.appSignIn(APP, signIn()));
    clock.advance(60_000);
    // The issuer's change happens now: a ban, say. A session that starts from now on is a sign-in it let in.
    const change = new Date(clock.now()).toISOString();
    value(await store.appSignIn(APP, signIn({ session: { id: SESSION_2, days: 14 } })));
    const banned = { issuer: ISSUER, sub: "sub-sam", before: change };
    assert.deepEqual(value(await store.appIdentitySignOut(DEPLOYER, banned)), { ended: 1 });
    assert.deepEqual(value(await store.appSession(APP, { id: SESSION_1, whoOpens: "users" })), { ok: false, reason: "ended" });
    assert.equal(value(await store.appSession(APP, { id: SESSION_2, whoOpens: "users" })).ok, true, "a session that started at the change stays");
    // Asked again, as a caller that never heard the answer does: nothing more ends.
    assert.deepEqual(value(await store.appIdentitySignOut(DEPLOYER, banned)), { ended: 0 });
    // Another issuer's subject with the same sub is somebody else, and someone the list does not know has no session.
    assert.deepEqual(value(await store.appIdentitySignOut(DEPLOYER, { ...banned, issuer: "https://other.example/oidc", before: new Date(clock.now() + 1).toISOString() })), { ended: 0 });
    assert.deepEqual(value(await store.appIdentitySignOut(DEPLOYER, { ...banned, sub: "sub-lee" })), { ended: 0 });
    // A later change ends the later session too; the person stays on the list as they were.
    clock.advance(1_000);
    assert.deepEqual(value(await store.appIdentitySignOut(DEPLOYER, { ...banned, before: new Date(clock.now()).toISOString() })), { ended: 1 });
    assert.deepEqual(value(await store.appSession(APP, { id: SESSION_2, whoOpens: "users" })), { ok: false, reason: "ended" });
    assert.deepEqual(
      value(await store.appUsers(DEPLOYER)).users.map((u) => [u.email, u.status]),
      [["sam@acme.test", "active"]],
    );
    for (const body of [{ ...banned, before: "yesterday" }, { ...banned, issuer: "" }, { ...banned, sub: 7 }, { issuer: ISSUER, sub: "sub-sam" }]) {
      assert.equal(refusal(await store.appIdentitySignOut(DEPLOYER, body as never)).code, "bad_request");
    }
  });

  it("turns an author's own row into a listed person's when they are invited", async () => {
    const { store } = setup();
    const author = value(await store.appSignIn(APP, signIn({ whoOpens: "authors", author: true })));
    assert.equal(author.ok && author.user.author, true);
    const listed = value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Admin" })).user;
    assert.equal(listed.author, false);
    assert.equal(listed.role, "Admin");
    const session = value(await store.appSession(APP, { id: SESSION_1, whoOpens: "users" }));
    assert.deepEqual(session.ok && session.opens, { asAuthor: true, asOther: true });
  });

  it("makes an author's row a listed person's once someone marks them a tester", async () => {
    const { store } = setup();
    const author = value(await store.appSignIn(APP, signIn({ whoOpens: "authors-testers", author: true })));
    assert.equal(author.ok && author.user.author, true);
    const marked = value(await store.appUserUpdate(DEPLOYER, author.ok ? author.user.id : "", { tester: true })).user;
    assert.equal(marked.author, false);
    const session = value(await store.appSession(APP, { id: SESSION_1, whoOpens: "authors-testers" }));
    assert.deepEqual(session.ok && session.opens, { asAuthor: true, asOther: true });
  });

  it("finds a person by their sign-in or their email", async () => {
    const { store } = setup();
    value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Admin" }));
    value(await store.appSignIn(APP, signIn()));
    assert.equal(value(await store.appUserFind(APP, { issuer: ISSUER, sub: "sub-sam" })).user?.email, "sam@acme.test");
    assert.equal(value(await store.appUserFind(APP, { email: "SAM@acme.test" })).user?.sub, "sub-sam");
    assert.equal(value(await store.appUserFind(APP, { email: "nobody@acme.test" })).user, null);
  });
});

describe("a restore", () => {
  itRestores("keeps the user list and the sessions as they are now", async () => {
    const { store, storage, clock, make } = await withLoans();
    const sam = value(await store.appUserInvite(DEPLOYER, { email: "sam@acme.test", role: "Borrower" })).user;
    value(await store.appSignIn(APP, signIn()));
    clock.advance(1_000);
    const point = value(await store.migrate(DEPLOYER, { id: "0001_notes", sql: "CREATE TABLE notes (v TEXT)" })).migration.restorePoint!;
    clock.advance(1_000);
    // After the moment: Sam is removed (his session ends), and Lee is invited.
    value(await store.appUserUpdate(DEPLOYER, sam.id, { status: "removed" }));
    value(await store.appUserInvite(DEPLOYER, { email: "lee@acme.test", role: "Borrower" }));
    value(await store.restore({ storeId: A, actor: "user:admin" }, { at: point }));
    storage.restart();
    const after = make();
    assert.deepEqual(value(await after.query(DEPLOYER, { sql: "SELECT count(*) FROM sqlite_master WHERE name = 'notes'" })).rows, [[0]], "the data went back");
    assert.deepEqual(value(await after.appSession(APP, { id: SESSION_1, whoOpens: "users" })), { ok: false, reason: "ended" }, "the ended session stays ended");
    assert.deepEqual(
      value(await after.appUsers(DEPLOYER)).users.map((u) => [u.email, u.status]),
      [
        ["sam@acme.test", "removed"],
        ["lee@acme.test", "invited"],
      ],
    );
  });
});
