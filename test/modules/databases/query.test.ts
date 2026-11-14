// Running a query for a data island: the function of the module, called
// through the door that checks the two keys.
//
// The door here is the rig's stand-in for the module host's. It checks the
// person's sign-in at the Fortress, then a grant the control plane signed for
// exactly this person, this connection and these settings, in the order the
// host's contract gives. The grants are real: signed with a key made for the
// test run, and verified.
//
// What must hold: with either key missing or wrong nothing runs; a statement
// that writes does not run; every query leaves a line with the person and the
// statement's text; and the rows go to the caller and nowhere else.

import { afterEach, describe, expect, test } from "bun:test";

import { QueryRefused } from "../../../src/modules/databases/query";
import { ask, spoolText } from "../../host/_module-rig";
import {
  addConnection,
  islandGrant,
  LENA,
  makeDatabasesRig,
  MARTA,
  PERMITS,
  query,
  readRows,
  RUTH,
  type DatabasesRig,
  type QueryCall,
} from "./_rig";
import { PERMITS_PASSWORD } from "./standin-data-runner";

let rig: DatabasesRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

const FIRST_3 = "SELECT TOP 3 permit_no, address, type, issued FROM permits ORDER BY permit_no";
const SETTINGS = { query: FIRST_3 };

/** A read with both keys in order, with any part replaced. */
async function call(of: DatabasesRig, change: Partial<QueryCall> = {}): Promise<QueryCall> {
  return {
    session: LENA,
    grant: await islandGrant(of, {
      kind: "table",
      target: PERMITS.name,
      settings: SETTINGS,
      person: LENA.email ?? "",
    }),
    kind: "table",
    target: PERMITS.name,
    settings: SETTINGS,
    ...change,
  };
}

async function ready(options: Parameters<typeof makeDatabasesRig>[0] = {}): Promise<DatabasesRig> {
  const made = await makeDatabasesRig(options);
  await addConnection(made);
  return made;
}

describe("a query with both keys", () => {
  test("answers the rows to the person, and writes a line with the person and the statement", async () => {
    rig = await ready();
    expect(await query(rig, await call(rig))).toEqual({
      status: 200,
      columns: [
        { name: "permit_no", type: "nvarchar" },
        { name: "address", type: "nvarchar" },
        { name: "type", type: "nvarchar" },
        { name: "issued", type: "date" },
      ],
      rows: [
        ["BP-2026-0412", "18 Mill Road", "Deck", "2026-03-02"],
        ["BP-2026-0413", "7 Alder Court", "Roof", "2026-03-02"],
        ["BP-2026-0415", "221 Main Street", "Solar", "2026-03-03"],
      ],
      more: false,
    });
    expect(rig.queries.records).toEqual([
      {
        person: "lena.hart@northstar.example",
        connection: "Northstar permits",
        statement: FIRST_3,
        job: expect.stringMatching(/^job_/) as unknown as string,
        outcome: { outcome: "ran", rows: 3, more: false },
      },
    ]);
  });

  test("the program is handed the statement, the most rows to answer, and the read login", async () => {
    rig = await ready();
    await query(rig, await call(rig));
    expect(rig.jobs).toHaveLength(1);
    expect(rig.jobs[0]).toMatchObject({
      kind: "query",
      params: { sql: FIRST_3, limit: 200 },
      login: { kind: "read", user: "permits_reader", password: PERMITS_PASSWORD },
      reach: { kind: "direct", host: PERMITS.host, port: PERMITS.port },
      deadline: new Date(rig.now.value.getTime() + 120_000).toISOString(),
    });
  });

  test("the settings may name fewer rows, and the answer says when the statement has more", async () => {
    rig = await ready();
    const reply = await readRows(rig, "SELECT permit_no FROM permits ORDER BY permit_no", LENA, { rows: 2 });
    expect(reply).toMatchObject({ status: 200, rows: [["BP-2026-0412"], ["BP-2026-0413"]], more: true });
    expect(rig.jobs[0]).toMatchObject({ params: { limit: 2 } });
    expect(rig.queries.records[0]?.outcome).toEqual({ outcome: "ran", rows: 2, more: true });
    for (const rows of [0, 201, 2.5, "3"]) {
      expect(await readRows(rig, "SELECT permit_no FROM permits", LENA, { rows })).toMatchObject({
        status: 422,
        code: "query-failed",
      });
    }
    expect(rig.jobs).toHaveLength(1);
  });

  test("the rows are in no answer to an ask, no audit record, no log line and no state", async () => {
    rig = await ready();
    await query(rig, await call(rig));
    const everywhere = [
      JSON.stringify(await ask(rig, "databases", "connections.list")),
      await spoolText(rig.paths),
      JSON.stringify(rig.logs),
      JSON.stringify(await rig.ctx.state.read("connections")),
      // The record of the query holds the statement and a count.
      JSON.stringify(rig.queries.records),
    ].join("\n");
    for (const value of ["18 Mill Road", "7 Alder Court", "221 Main Street", "BP-2026-0412"]) {
      expect(everywhere).not.toContain(value);
    }
  });
});

describe("a key that is missing or wrong", () => {
  test("nobody signed in: refused before the grant is looked at", async () => {
    rig = await ready();
    expect(await query(rig, await call(rig, { session: null }))).toMatchObject({ status: 401, code: "signed-out" });
    expect(await query(rig, await call(rig, { session: null, grant: null }))).toMatchObject({ code: "signed-out" });
  });

  test("no grant", async () => {
    rig = await ready();
    expect(await query(rig, await call(rig, { grant: null }))).toMatchObject({ status: 403, code: "grant-missing" });
  });

  test("a grant for another person", async () => {
    rig = await ready();
    // The control plane vouched for Lena. Ruth is signed in.
    expect(await query(rig, await call(rig, { session: RUTH }))).toMatchObject({
      status: 403,
      code: "grant-other-person",
    });
    // And the other way round: a grant for Ruth, with Lena signed in.
    const forRuth = await islandGrant(rig, {
      kind: "table",
      target: PERMITS.name,
      settings: SETTINGS,
      person: RUTH.email ?? "",
    });
    expect(await query(rig, await call(rig, { grant: forRuth }))).toMatchObject({ code: "grant-other-person" });
  });

  test("a grant signed with another key, or changed after it was signed", async () => {
    rig = await ready();
    const other = await makeDatabasesRig();
    try {
      const foreign = await islandGrant(other, {
        kind: "table",
        target: PERMITS.name,
        settings: SETTINGS,
        person: LENA.email ?? "",
      });
      expect(await query(rig, await call(rig, { grant: foreign }))).toMatchObject({ code: "grant-signature" });
    } finally {
      await other.cleanup();
    }
    const good = (await call(rig)).grant as string;
    const [head, body, signature] = good.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...claims, person: RUTH.email })).toString("base64url");
    expect(await query(rig, await call(rig, { session: RUTH, grant: `${head}.${forged}.${signature}` }))).toMatchObject(
      { code: "grant-signature" },
    );
    expect(await query(rig, await call(rig, { grant: "not a grant" }))).toMatchObject({ code: "grant-signature" });
  });

  test("a grant for something else: a module's ask, another connection, another kind, other settings", async () => {
    rig = await ready();
    await addConnection(rig, { ...PERMITS, name: "Northstar archive" });
    const moduleGrant = await rig.key.grant("databases", "connections.list", {});
    expect(await query(rig, await call(rig, { grant: moduleGrant }))).toMatchObject({ code: "grant-purpose" });
    // The grant names "Northstar permits". The read asks for another connection.
    expect(await query(rig, await call(rig, { target: "Northstar archive" }))).toMatchObject({
      code: "grant-other-island",
    });
    expect(await query(rig, await call(rig, { kind: "rows" }))).toMatchObject({ code: "grant-other-island" });
    // The grant vouches for one statement. Another statement is other settings.
    expect(
      await query(rig, await call(rig, { settings: { query: "SELECT applicant FROM permits" } })),
    ).toMatchObject({ code: "grant-other-settings" });
    expect(await query(rig, await call(rig, { settings: { ...SETTINGS, rows: 200 } }))).toMatchObject({
      code: "grant-other-settings",
    });
    expect(rig.jobs).toEqual([]);
  });

  test("a grant that has run out, lives too long, or was used before", async () => {
    rig = await ready();
    const island = { kind: "table", target: PERMITS.name, settings: SETTINGS, person: LENA.email ?? "" };
    const old = await islandGrant(rig, island);
    rig.now.value = new Date(rig.now.value.getTime() + 61_000);
    expect(await query(rig, await call(rig, { grant: old }))).toMatchObject({ code: "grant-expired" });
    const long = await islandGrant(rig, island, {}, { ttl: 3_600 });
    expect(await query(rig, await call(rig, { grant: long }))).toMatchObject({ code: "grant-expired" });

    const once = await islandGrant(rig, island);
    expect(await query(rig, await call(rig, { grant: once }))).toMatchObject({ status: 200 });
    expect(await query(rig, await call(rig, { grant: once }))).toMatchObject({ status: 403, code: "grant-used" });
    expect(rig.jobs).toHaveLength(1);
  });

  test("a person whose groups may not see rows, and a module that is off", async () => {
    rig = await ready();
    expect(await query(rig, await call(rig, { mayReadRows: false }))).toMatchObject({
      status: 403,
      code: "not-allowed",
    });
    expect(rig.jobs).toEqual([]);
    const off = await makeDatabasesRig({ enabled: ["session_vault", "probe"] });
    try {
      expect(await query(off, await call(off))).toMatchObject({ status: 403, code: "not-allowed" });
    } finally {
      await off.cleanup();
    }
  });

  test("with a key missing or wrong, the module is not called and no job starts", async () => {
    rig = await ready();
    let called = 0;
    const onDataIsland = rig.module.onDataIsland.bind(rig.module);
    rig.module.onDataIsland = (...args) => {
      called += 1;
      return onDataIsland(...args);
    };
    for (const change of [
      { session: null },
      { grant: null },
      { session: RUTH },
      { target: "Another connection" },
      { settings: { query: "SELECT 1" } },
      { mayReadRows: false },
    ] as Partial<QueryCall>[]) {
      expect((await query(rig, await call(rig, change))).status).not.toBe(200);
    }
    expect(called).toBe(0);
    expect(rig.jobs).toEqual([]);
    expect(rig.queries.records).toEqual([]);
  });
});

describe("a statement that does not only read", () => {
  test.each([
    ["UPDATE permits SET type = 'closed' WHERE permit_no = 'BP-2026-0412'", "statement_not_a_select"],
    ["SELECT * INTO permits_copy FROM permits", "statement_writes"],
    ["WITH gone AS (SELECT 1 AS a) DELETE FROM permits", "statement_writes"],
    ["SELECT 1; DROP TABLE permits", "statement_several_statements"],
    ["SELECT 1 /*!50000 INTO OUTFILE '/tmp/permits' */", "statement_comment_that_runs"],
    ["   ", "statement_missing"],
  ])("is refused, with the grant in order, and nothing is started: %s", async (statement, rule) => {
    rig = await ready();
    const reply = await readRows(rig, statement, LENA);
    expect(reply).toMatchObject({ status: 422, code: "query-failed" });
    expect((reply as { words: string }).words.length).toBeGreaterThan(10);
    // No program was started, and no secret was read.
    expect(rig.jobs).toEqual([]);
    expect(rig.keyStore.reads).toEqual([]);
    // The refusal is a line too: who, on which connection, the text, and why.
    expect(rig.queries.records).toEqual([
      {
        person: "lena.hart@northstar.example",
        connection: "Northstar permits",
        statement,
        outcome: { outcome: "refused", rule },
      },
    ]);
  });

  test("a statement longer than a query takes is refused, and its start is kept", async () => {
    rig = await ready();
    const long = `SELECT permit_no FROM permits WHERE note = '${"x".repeat(20_000)}'`;
    expect(await readRows(rig, long, LENA)).toMatchObject({ status: 422, code: "query-failed" });
    expect(rig.queries.records[0]?.statement).toHaveLength(20_000);
    expect(rig.queries.records[0]?.outcome).toEqual({ outcome: "refused", rule: "statement_too_long" });
    expect(rig.jobs).toEqual([]);
  });

  test("the statement is the one in the settings the grant covers, wherever else one is offered", async () => {
    rig = await ready();
    const made = await call(rig);
    // The data island's own body offers another statement. It is not read.
    const answer = await rig.module.onDataIsland(
      { kind: "table", target: PERMITS.name, settings: SETTINGS, body: { query: "DELETE FROM permits", sql: "DELETE FROM permits" } },
      rig.ctx,
      LENA,
    );
    void made;
    expect(answer.rows).toHaveLength(3);
    expect(rig.jobs[0]).toMatchObject({ params: { sql: FIRST_3 } });
  });
});

describe("a query that fails", () => {
  test("the database's own words reach the person, and are kept nowhere", async () => {
    rig = await ready();
    const reply = await readRows(rig, "SELECT lot FROM broken_view", LENA);
    expect(reply).toEqual({
      status: 422,
      code: "query-failed",
      words: "Conversion failed when converting the nvarchar value '18 Mill Road' to data type int.",
    });
    expect(rig.queries.records[0]?.outcome).toEqual({ outcome: "failed", code: "database" });
    const kept = [
      JSON.stringify(rig.queries.records),
      await spoolText(rig.paths),
      JSON.stringify(rig.logs),
      JSON.stringify(await rig.ctx.state.read("connections")),
    ].join("\n");
    expect(kept).not.toContain("18 Mill Road");
    expect(kept).not.toContain("Conversion failed");
  });

  test("a failure that is not the database's is said in this Fortress's own words", async () => {
    rig = await ready();
    await addConnection(rig, { ...PERMITS, name: "Northstar archive", host: "sql09.northstar.example" });
    const settings = { query: "SELECT permit_no FROM permits" };
    const reply = await query(rig, {
      session: LENA,
      grant: await islandGrant(rig, { kind: "rows", target: "Northstar archive", settings, person: LENA.email ?? "" }),
      kind: "rows",
      target: "Northstar archive",
      settings,
    });
    expect(reply).toEqual({
      status: 422,
      code: "query-failed",
      words: "This Fortress could not reach the database's server.",
    });
    expect(rig.queries.records[0]).toMatchObject({
      connection: "Northstar archive",
      outcome: { outcome: "failed", code: "unreachable" },
    });
  });

  test("a connection this organization does not have", async () => {
    rig = await ready();
    const settings = { query: "SELECT 1" };
    const reply = await query(rig, {
      session: LENA,
      grant: await islandGrant(rig, { kind: "table", target: "Nowhere", settings, person: LENA.email ?? "" }),
      kind: "table",
      target: "Nowhere",
      settings,
    });
    expect(reply).toMatchObject({ status: 422, code: "query-failed" });
    expect(rig.queries.records[0]).toMatchObject({
      connection: "Nowhere",
      outcome: { outcome: "refused", rule: "connection_unknown" },
    });
  });

  test("a kind of data island this module does not answer", async () => {
    rig = await ready();
    await expect(
      rig.module.onDataIsland({ kind: "upload", target: PERMITS.name, settings: SETTINGS }, rig.ctx, LENA),
    ).rejects.toMatchObject({ code: "not-allowed", reason: "kind_not_served" });
    expect(rig.jobs).toEqual([]);
  });

  test("when the line for the audit trail cannot be written, the query does not run", async () => {
    rig = await ready();
    rig.queries.unwritable = true;
    const reply = await query(rig, await call(rig));
    expect(reply).toEqual({
      status: 422,
      code: "query-failed",
      words: "This Fortress could not write the query to its audit trail, so it did not run it.",
    });
    // Nothing was started, and no secret was read.
    expect(rig.jobs).toEqual([]);
    expect(rig.keyStore.reads).toEqual([]);
  });

  test("a query takes a place among the running jobs, and gives it back", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rig = await ready({ hold: () => held, maxRunning: 2 });
    const first = query(rig, await call(rig));
    const second = query(rig, await call(rig));
    // Both are with the program now. A third finds no place.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await query(rig, await call(rig))).toMatchObject({
      status: 422,
      code: "query-failed",
      words: "Too many jobs are running on this Fortress. Try again in a moment.",
    });
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await query(rig, await call(rig))).status).toBe(200);
  });

  test("the person named in a line is the email, or the console login of an account with none", async () => {
    rig = await ready();
    await rig.module.onDataIsland(
      { kind: "table", target: PERMITS.name, settings: SETTINGS },
      rig.ctx,
      { ...MARTA, email: null },
    );
    expect(rig.queries.records[0]?.person).toBe("marta");
  });
});

describe("on a Fortress of this build", () => {
  test("the daemon's own stand-ins record no query, so none runs", async () => {
    rig = await makeDatabasesRig({ asInTheDaemon: true });
    await addConnection(rig);
    const refused = await rig.module
      .onDataIsland({ kind: "table", target: PERMITS.name, settings: SETTINGS }, rig.ctx, LENA)
      .catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(QueryRefused);
    expect(refused).toMatchObject({ code: "query-failed", reason: "record_unavailable" });
    expect(rig.keyStore.reads).toEqual([]);
  });
});
