// The two shapes between the module and the data runner program: the job the
// module hands over, and the output it reads back. And the program itself,
// started as a child process for one job, the way the module host will start
// the real one.

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { queryJob, readOutput, testJob } from "../../../src/modules/databases/data-runner";
import { act, addConnection, makeDatabasesRig, PERMITS, programJob, testConnection, type DatabasesRig } from "./_rig";
import { PERMITS_PASSWORD, runStandInJob } from "./standin-data-runner";

let rig: DatabasesRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

const NOW = new Date("2027-03-14T09:00:00.000Z");
const SUBJECT = {
  engine: "sqlserver",
  database: "Permits",
  encryption: "verify",
  minTls: "1.2",
  user: "permits_reader",
} as const;

describe("the job the module hands over", () => {
  test("a test job holds no address and no password, and ends in two minutes", () => {
    expect(testJob("job_1", SUBJECT, NOW)).toEqual({
      v: 1,
      id: "job_1",
      kind: "test",
      engine: "sqlserver",
      database: "Permits",
      tls: { mode: "verify", minVersion: "1.2" },
      login: { kind: "read", user: "permits_reader" },
      deadline: "2027-03-14T09:02:00.000Z",
    });
  });

  test("a query job adds one statement and the most rows to answer", () => {
    expect(queryJob("job_2", { ...SUBJECT, serverName: "sql.northstar.example" }, "SELECT 1", 3, NOW)).toEqual({
      v: 1,
      id: "job_2",
      kind: "query",
      engine: "sqlserver",
      database: "Permits",
      tls: { mode: "verify", minVersion: "1.2", serverName: "sql.northstar.example" },
      login: { kind: "read", user: "permits_reader" },
      deadline: "2027-03-14T09:02:00.000Z",
      params: { sql: "SELECT 1", limit: 3 },
    });
  });

  test("the program reads the module's fields with the address and the password the host adds", () => {
    const job = programJob(testJob("job_1", SUBJECT, NOW), { host: "sql01.northstar.example", port: 1433 }, {
      password: PERMITS_PASSWORD,
    });
    expect(job).toMatchObject({
      server: { host: "sql01.northstar.example", port: 1433 },
      reach: { kind: "direct", host: "sql01.northstar.example", port: 1433 },
      login: { kind: "read", user: "permits_reader", password: PERMITS_PASSWORD },
    });
    expect(runStandInJob(job, undefined, NOW)).toMatchObject({ ok: true, id: "job_1" });
  });
});

describe("the output the module reads back", () => {
  const job = programJob(testJob("job_1", SUBJECT, NOW), { host: "sql01.northstar.example", port: 1433 }, {
    password: PERMITS_PASSWORD,
  });
  const good = runStandInJob(job, undefined, NOW);

  test("a test's findings are rebuilt from the fields the module knows", () => {
    const read = readOutput(good, { id: "job_1", kind: "test" });
    if (!read.ok || read.findings.kind !== "test") throw new Error("the output was not read");
    expect(read.findings).toMatchObject({ encryption: "verified", canWrite: false, writableTables: 0, truncated: false });
    expect(read.findings.tables).toHaveLength(5);
    // The server's version sentence, the cipher and the times are not kept.
    const text = JSON.stringify(read);
    for (const dropped of ["Example SQL Server", "TLS_AES", "serverVersion", "writable\""]) {
      expect(text).not.toContain(dropped);
    }
  });

  test.each([
    ["not an object", "a line of text"],
    ["null", null],
    ["another version", { ...good, v: 2 }],
    ["another job's id", { ...good, id: "job_2" }],
    ["no result", { ...good, result: undefined }],
    ["a query's result for a test", { ...good, result: { kind: "query", columns: [], rows: [], truncated: false } }],
    ["a catalog that is not a list", { ...good, result: { ...(good.result as object), catalog: { tables: {}, truncated: false } } }],
    [
      "a table whose rows is text",
      {
        ...good,
        result: {
          ...(good.result as object),
          catalog: {
            truncated: false,
            tables: [{ schema: "dbo", name: "permits", kind: "table", rows: "18 Mill Road", columns: [] }],
          },
        },
      },
    ],
    [
      "a column with no type",
      {
        ...good,
        result: {
          ...(good.result as object),
          catalog: {
            truncated: false,
            tables: [{ schema: "dbo", name: "permits", kind: "table", rows: 1, columns: [{ name: "a", nullable: true }] }],
          },
        },
      },
    ],
  ])("an output that is not one is refused whole: %s", (_what, value) => {
    expect(readOutput(value, { id: "job_1", kind: "test" })).toEqual({
      ok: false,
      code: "output_invalid",
      message: "",
    });
  });

  test("a failure keeps its word, and a word this build does not know is the program's own fault", () => {
    const fail = (code: string, id = "job_1"): unknown => ({
      v: 1,
      id,
      ok: false,
      where: null,
      error: { code, message: "The database said: 18 Mill Road." },
      ms: 3,
    });
    for (const code of ["unreachable", "tls", "login", "database", "deadline", "not_ready", "internal"]) {
      expect(readOutput(fail(code), { id: "job_1", kind: "test" })).toMatchObject({ ok: false, code });
    }
    // Words of a job that does not dial a server itself, and words nobody listed.
    for (const code of ["outside_us", "connector_offline", "access_refused", "limit", "store", "brand_new", 7]) {
      expect(readOutput(fail(code as string), { id: "job_1", kind: "test" })).toMatchObject({
        ok: false,
        code: "internal",
      });
    }
    // A job the program could not read at all comes back with no id.
    expect(readOutput(fail("internal", ""), { id: "job_1", kind: "test" })).toMatchObject({ code: "internal" });
    expect(readOutput(fail("login", "job_2"), { id: "job_1", kind: "test" })).toMatchObject({
      code: "output_invalid",
    });
    expect(readOutput({ ...(fail("login") as object), error: "refused" }, { id: "job_1", kind: "test" })).toMatchObject({
      code: "output_invalid",
    });
  });

  test("a query's answer has one value for each column of each row, and no more rows than were asked for", () => {
    const answer = (rows: unknown, columns: unknown = [{ name: "permit_no", type: "nvarchar" }]): unknown => ({
      v: 1,
      id: "job_3",
      ok: true,
      where: null,
      result: { kind: "query", columns, rows, truncated: false, ms: {} },
      ms: 1,
    });
    const about = { id: "job_3", kind: "query", rowCap: 2 } as const;
    expect(readOutput(answer([["BP-2026-0412"], [null]]), about)).toEqual({
      ok: true,
      findings: {
        kind: "query",
        columns: [{ name: "permit_no", type: "nvarchar" }],
        rows: [["BP-2026-0412"], [null]],
        more: false,
      },
    });
    for (const bad of [
      answer([["a"], ["b"], ["c"]]),
      answer([["a", "b"]]),
      answer([[7]]),
      answer([[{ nested: "18 Mill Road" }]]),
      answer("18 Mill Road"),
      answer([["x".repeat(2_001)]]),
      answer([["a"]], [{ name: "permit_no" }]),
    ]) {
      expect(readOutput(bad, about)).toMatchObject({ ok: false, code: "output_invalid" });
    }
  });
});

describe("the program, started for one job", () => {
  const RUNNER = path.join(import.meta.dir, "standin-data-runner.ts");

  async function start(args: string[], stdin: string): Promise<{ code: number; out: string; err: string }> {
    const child = Bun.spawn([process.execPath, RUNNER, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    });
    child.stdin.write(stdin);
    await child.stdin.end();
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, out, err };
  }

  const job = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      ...(programJob(testJob("job_1", SUBJECT, new Date()), { host: "sql01.northstar.example", port: 1433 }, {
        password: PERMITS_PASSWORD,
      }) as object),
      ...extra,
    });

  test("prints one line and exits 0, and never prints the login", async () => {
    const run = await start(["run", "--job-stdin"], job());
    expect(run.code).toBe(0);
    expect(run.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(run.out)).toMatchObject({ v: 1, id: "job_1", ok: true });
    expect(run.out + run.err).not.toContain(PERMITS_PASSWORD);
    expect(run.out + run.err).not.toContain("permits_reader");
  });

  test("exits 0 for a job that failed, and refuses a field it does not know", async () => {
    const wrong = await start(["run", "--job-stdin"], job({ login: { kind: "read", user: "permits_reader", password: "wrong" } }));
    expect(wrong.code).toBe(0);
    expect(JSON.parse(wrong.out)).toMatchObject({ ok: false, error: { code: "login" } });
    const unknown = await start(["run", "--job-stdin"], job({ country: "US", also: "this" }));
    expect(unknown.code).toBe(0);
    expect(JSON.parse(unknown.out)).toMatchObject({ ok: false, id: "", error: { code: "internal" } });
    const garbage = await start(["run", "--job-stdin"], "not json");
    expect(JSON.parse(garbage.out)).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  test("a wrong command line is exit code 2, with nothing on standard output", async () => {
    const run = await start(["serve"], "");
    expect(run).toMatchObject({ code: 2, out: "" });
  });

  test("the module's test of a connection works with the program as a real child process", async () => {
    rig = await makeDatabasesRig({ mode: "process" });
    await addConnection(rig);
    const id = await testConnection(rig);
    expect(await act(rig, "job.read", { job: id })).toMatchObject({
      ok: true,
      payload: { state: "done", tables: 4, columns: 14, encryption: "verified", canWrite: false },
    });
    // The secret was read once, by its name, by the launcher: the stand-in for
    // the host. The program was handed the value.
    expect(rig.keyStore.reads).toEqual(["permits-reader"]);
    expect(rig.jobs).toHaveLength(1);
    expect(rig.jobs[0]).toMatchObject({
      id,
      kind: "test",
      server: { host: PERMITS.host, port: PERMITS.port },
      reach: { kind: "direct", host: PERMITS.host, port: PERMITS.port },
      login: { kind: "read", user: PERMITS.user, password: PERMITS_PASSWORD },
    });
  });

  test("a program that does not end on its own is failed, not waited on for ever", async () => {
    rig = await makeDatabasesRig({ mode: "process", programTimeoutMs: 400 });
    await addConnection(rig, { ...PERMITS, host: "slow.northstar.example" });
    const id = await testConnection(rig);
    expect(await act(rig, "job.read", { job: id })).toMatchObject({
      ok: true,
      payload: { state: "failed", code: "timeout", step: "start" },
    });
  });
});
