// The Databases module on the module host's own port for a helper program: a
// person's test of a connection, from the act to the connection's state.
//
// DB IO is another binary, built from the folder `data-runner/`. A program of
// this test stands in its place: it reads the job from its standard input, as
// DB IO does, keeps a copy of it beside itself, and prints the answer that
// DB IO's own contract has for a test that went well
// (`data-runner/contract/output-test-ok.json`).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AuditRecord } from "../../../src/console/audit-spool";
import { ownWordFor } from "../../../src/modules/databases/standins";
import { FAILURE_CODES } from "../../../src/modules/databases/manifest";
import { PROGRAM_FAILURE_CODES } from "../../../src/host/module-contract";
import { spoolRecords, spoolText } from "../../host/_module-rig";
import { act, addConnection, makeDatabasesRig, PERMITS, testConnection, type DatabasesRig } from "./_rig";

let rig: DatabasesRig | null = null;
let dirs: string[] = [];
afterEach(async () => {
  await rig?.cleanup().catch(() => {});
  rig = null;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

/** Where the runtime and `env` are found: what the daemon's own PATH is here. */
const PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
// A made-up value in the place of the login's password.
const PASSWORD = ["a-password", "of-this", "test"].join("-");
const ADDRESS = "203.0.113.7";

/** A program in DB IO's place, as a file that can be run. */
async function standIn(): Promise<{ file: string; dir: string }> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "hx-fortress-db-io-")));
  dirs.push(dir);
  const answer = await readFile(
    new URL("../../../data-runner/contract/output-test-ok.json", import.meta.url),
    "utf8",
  );
  const file = path.join(dir, "db-io-stand-in.ts");
  const source = [
    "#!/usr/bin/env bun",
    'import { writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "const job = JSON.parse(await Bun.stdin.text());",
    'writeFileSync(path.join(import.meta.dir, "job.json"), JSON.stringify(job));',
    "writeFileSync(",
    '  path.join(import.meta.dir, "started.json"),',
    "  JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env).sort(), names: process.env.DB_IO_NAMES_ITSELF }),",
    ");",
    `const answer = ${JSON.stringify(JSON.parse(answer))};`,
    "answer.id = job.id;",
    'process.stderr.write("stage connect\\n");',
    'process.stdout.write(JSON.stringify(answer) + "\\n");',
    "",
  ].join("\n");
  await writeFile(file, source, { mode: 0o755 });
  return { file, dir };
}

const line = (record: AuditRecord): string =>
  `${record.action} ${record.kind} ${record.outcome ?? "-"}${record.error ? ` ${record.error}` : ""}`;

describe("a person tests a connection on a host that has DB IO", () => {
  test("the module host runs the program, and the connection is ready", async () => {
    const program = await standIn();
    const lookedUp: string[] = [];
    rig = await makeDatabasesRig({
      asInTheDaemon: true,
      hostDeps: {
        env: { PATH, FORTRESS_DATA_RUNNER: program.file, PGPASSWORD: "the daemon's own" },
        reachLookup: async (name) => {
          lookedUp.push(name);
          return [{ address: ADDRESS, family: 4 }];
        },
      },
    });
    rig.secrets.values[PERMITS.keyName] = PASSWORD;
    await addConnection(rig);
    const job = await testConnection(rig);

    expect(await act(rig, "job.read", { job })).toMatchObject({ ok: true, payload: { state: "done" } });
    expect(await act(rig, "connections.read")).toMatchObject({
      payload: { connections: [{ name: PERMITS.name, state: "ready" }] },
    });

    // The job as the program read it: the module's fields, and what the host
    // put in from the list of hosts and from the key store.
    const read = JSON.parse(await readFile(path.join(program.dir, "job.json"), "utf8")) as Record<string, unknown>;
    expect(read).toMatchObject({
      v: 1,
      id: job,
      kind: "test",
      engine: PERMITS.engine,
      database: PERMITS.database,
      server: { host: PERMITS.host, port: PERMITS.port },
      reach: { kind: "direct", host: ADDRESS, port: PERMITS.port },
      login: { kind: "read", user: PERMITS.user, password: PASSWORD },
    });
    expect(lookedUp).toEqual([PERMITS.host]);
    expect(rig.secrets.reads).toEqual([PERMITS.keyName]);
    // How it was started: the list's arguments and variable, and nothing of
    // the daemon's own but PATH.
    const started = JSON.parse(await readFile(path.join(program.dir, "started.json"), "utf8")) as {
      args: string[];
      env: string[];
      names: string;
    };
    expect(started.args).toEqual(["run", "--job-stdin"]);
    expect(started.names).toBe("1");
    expect(started.env.filter((name) => !name.startsWith("BUN_"))).toEqual(["DB_IO_NAMES_ITSELF", "PATH"]);

    // The audit trail: the person's test, the host's own pair for the run of
    // the program, and how the test ended.
    const records = (await spoolRecords(rig.paths)).filter(
      (record) => record.action.startsWith("system.module.program") || record.action.startsWith("module.databases.connection.test"),
    );
    expect(records.map(line)).toEqual([
      "module.databases.connection.test outcome done",
      "system.module.program intent -",
      "system.module.program outcome ok",
      "module.databases.connection.tested outcome done",
    ]);
    expect(records[1]?.params).toMatchObject({ module: "databases", program: "data-runner" });
    // The password is in no record and in no line of the log, and neither is
    // the address or what the program found.
    const written = (await spoolText(rig.paths)) + JSON.stringify(rig.logs);
    for (const kept of [PASSWORD, ADDRESS, "permit_number", "SQL Server 2022"]) {
      expect([kept, written.includes(kept)]).toEqual([kept, false]);
    }
    // What the program says on its error output is in the log.
    expect(JSON.stringify(rig.logs)).toContain("stage connect");
  }, 30_000);

  test("a name that leads to this machine is not reached, and the test says the server could not be reached", async () => {
    const program = await standIn();
    rig = await makeDatabasesRig({
      asInTheDaemon: true,
      hostDeps: {
        env: { PATH, FORTRESS_DATA_RUNNER: program.file },
        reachLookup: async () => [{ address: "127.0.0.1", family: 4 }],
      },
    });
    rig.secrets.values[PERMITS.keyName] = PASSWORD;
    await addConnection(rig);
    const job = await testConnection(rig);
    expect(await act(rig, "job.read", { job })).toMatchObject({
      ok: true,
      payload: { state: "failed", code: "unreachable" },
    });
    // Nothing was started: the program kept no job.
    await expect(readFile(path.join(program.dir, "job.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const records = (await spoolRecords(rig.paths)).filter((record) => record.action === "system.module.program");
    expect(records.map(line)).toEqual([
      "system.module.program intent -",
      "system.module.program outcome refused reach_address_refused",
    ]);
  }, 30_000);
});

describe("the module host's words for a run that did not go well", () => {
  test("each is one of this module's own, and the ones it shares keep their word", () => {
    for (const code of PROGRAM_FAILURE_CODES) {
      const own = ownWordFor(code);
      expect([code, (FAILURE_CODES as readonly string[]).includes(own)]).toEqual([code, true]);
      if ((FAILURE_CODES as readonly string[]).includes(code)) expect([code, own]).toEqual([code, code]);
    }
    expect(
      Object.fromEntries(
        PROGRAM_FAILURE_CODES.filter((code) => !(FAILURE_CODES as readonly string[]).includes(code)).map((code) => [
          code,
          ownWordFor(code),
        ]),
      ),
    ).toEqual({
      job_invalid: "not_ready",
      audit_unavailable: "not_ready",
      reach_unresolved: "unreachable",
      reach_address_refused: "unreachable",
      module_not_running: "interrupted",
    });
  });
});
