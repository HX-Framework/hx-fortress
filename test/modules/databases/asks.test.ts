// The four asks of the Databases module, sent through the real ask gate, with
// a grant, exactly as a control plane sends them.
//
// What these tests are for: each answer has a fixed shape, and no answer can
// hold a row. The made-up database holds rows with values that stand for a
// customer's data. After the module has tested the connection and run a query
// on it, those values must be in no answer, no audit record, no log line and
// no file of the module's own state.

import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { manifestDefect } from "../../../src/host/module-contract";
import type { Shape } from "../../../src/host/shape";
import { DATABASES_MANIFEST, FAILURE_CODES } from "../../../src/modules/databases/manifest";
import { ask, spoolText, writeOrganizations } from "../../host/_module-rig";
import {
  act,
  addConnection,
  BILLING,
  LENA,
  makeDatabasesRig,
  PERMITS,
  readRows,
  testConnection,
  type DatabasesRig,
} from "./_rig";
import { BILLING_PASSWORD, PERMITS_PASSWORD, ROW_VALUES } from "./standin-data-runner";

let rig: DatabasesRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

type Reply = { ok: true; payload: unknown } | { ok: false; error: string } | undefined;

const payload = <T>(reply: Reply): T => {
  if (!reply || !reply.ok) throw new Error(`the ask was refused: ${reply ? reply.error : "no reply"}`);
  return reply.payload as T;
};

/** Every file under the fortress root, as one string. */
async function everythingOnDisk(root: string): Promise<string> {
  let text = "";
  // The test's own temp root, and the files found under it.
  /* eslint-disable security/detect-non-literal-fs-filename */
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += await readFile(path.join(entry.parentPath, entry.name), "utf8");
  }
  /* eslint-enable security/detect-non-literal-fs-filename */
  return text;
}

describe("the manifest", () => {
  test("is one the host can enforce, and lists four asks", () => {
    expect(manifestDefect(DATABASES_MANIFEST)).toBeNull();
    expect(DATABASES_MANIFEST.asks.map((spec) => spec.name)).toEqual([
      "connections.list",
      "catalog.read",
      "test.start",
      "job.read",
    ]);
    // The module calls no host over HTTPS and reads no secret itself.
    expect(DATABASES_MANIFEST.egress).toEqual([]);
    expect(DATABASES_MANIFEST.secrets).toEqual([]);
  });

  test("no ask takes anything but a connection's name, a page number and a job's id", () => {
    const fields = DATABASES_MANIFEST.asks.flatMap((spec) =>
      spec.args.kind === "record"
        ? Object.entries(spec.args.fields).map(([name, shape]) => `${spec.name}: ${name} ${shape.kind}`)
        : [],
    );
    expect(fields).toEqual([
      "catalog.read: connection name",
      "catalog.read: page count",
      "test.start: connection name",
      "job.read: job id",
    ]);
  });

  test("every value an answer can hold is a count, a flag, a state, a time, a name or an id", () => {
    const leaves = new Set<string>();
    const walk = (shape: Shape): void => {
      if (shape.kind === "list") walk(shape.of);
      else if (shape.kind === "record") Object.values(shape.fields).forEach(walk);
      else leaves.add(shape.kind);
    };
    for (const spec of DATABASES_MANIFEST.asks) walk(spec.reply);
    expect([...leaves].sort()).toEqual(["count", "flag", "id", "name", "state", "time"]);
  });

  test("the reach is direct, and an answer has no field for a site", () => {
    const list = DATABASES_MANIFEST.asks[0]?.reply as Extract<Shape, { kind: "record" }>;
    const item = (list.fields.connections as Extract<Shape, { kind: "list" }>).of as Extract<
      Shape,
      { kind: "record" }
    >;
    expect(item.fields.reach).toEqual({ kind: "state", of: ["direct"] });
    expect(Object.keys(item.fields)).toEqual([
      "name",
      "engine",
      "reach",
      "state",
      "testedAt",
      "failure",
      "canWrite",
    ]);
  });
});

describe("connections.list", () => {
  test("a Fortress with no connection answers an empty list", async () => {
    rig = await makeDatabasesRig();
    expect(await ask(rig, "databases", "connections.list")).toEqual({
      ok: true,
      payload: { connections: [] },
    });
  });

  test("answers each connection's name, engine, reach and state, and nothing of its server or login", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig, PERMITS);
    await addConnection(rig, BILLING);
    await testConnection(rig, PERMITS.name);
    const reply = await ask(rig, "databases", "connections.list");
    expect(reply).toEqual({
      ok: true,
      payload: {
        connections: [
          {
            name: "Northstar permits",
            engine: "sqlserver",
            reach: "direct",
            state: "ready",
            testedAt: rig.now.value.toISOString(),
            canWrite: false,
          },
          { name: "Northstar billing", engine: "postgres", reach: "direct", state: "not_tested" },
        ],
      },
    });
    const sent = JSON.stringify(reply);
    for (const hidden of [PERMITS.host, PERMITS.user, PERMITS.keyName, PERMITS.database, "1433"]) {
      expect(sent).not.toContain(hidden);
    }
  });

  test("a connection whose test failed says why, as one word", async () => {
    rig = await makeDatabasesRig();
    // The right server and the wrong login.
    await addConnection(rig, { ...PERMITS, user: "somebody_else" });
    await testConnection(rig);
    const { connections } = payload<{ connections: Record<string, unknown>[] }>(
      await ask(rig, "databases", "connections.list"),
    );
    expect(connections[0]).toMatchObject({ state: "failed", failure: "login" });
    expect(FAILURE_CODES).toContain("login");
  });
});

describe("test.start and job.read", () => {
  test("a test started by the control plane runs, and job.read says how it went", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const { job } = payload<{ job: string }>(
      await ask(rig, "databases", "test.start", { connection: PERMITS.name }),
    );
    await rig.module.idle();
    expect(await ask(rig, "databases", "job.read", { job })).toEqual({
      ok: true,
      payload: {
        connection: "Northstar permits",
        state: "done",
        step: "catalog",
        startedAt: rig.now.value.toISOString(),
        finishedAt: rig.now.value.toISOString(),
        // Two of the made-up database's five tables are left out of these
        // counts: one has a name an answer cannot hold, and so has one column.
        tables: 4,
        columns: 14,
        encryption: "verified",
        canWrite: false,
      },
    });
  });

  test("while a test runs, the job is running and the connection is testing", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rig = await makeDatabasesRig({ hold: () => held });
    await addConnection(rig);
    const { job } = payload<{ job: string }>(
      await ask(rig, "databases", "test.start", { connection: PERMITS.name }),
    );
    expect(payload<{ state: string; step: string }>(await ask(rig, "databases", "job.read", { job }))).toMatchObject({
      state: "running",
      step: "start",
    });
    const { connections } = payload<{ connections: { state: string }[] }>(
      await ask(rig, "databases", "connections.list"),
    );
    expect(connections[0]?.state).toBe("testing");
    // A second ask while the first test runs is answered with the same job.
    expect(await ask(rig, "databases", "test.start", { connection: PERMITS.name })).toEqual({
      ok: true,
      payload: { job },
    });
    release();
    await rig.module.idle();
  });

  test("the control plane cannot make the Fortress sign in to a database more than once a minute", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const first = payload<{ job: string }>(
      await ask(rig, "databases", "test.start", { connection: PERMITS.name }),
    );
    await rig.module.idle();
    rig.now.value = new Date(rig.now.value.getTime() + 59_000);
    const second = payload<{ job: string }>(
      await ask(rig, "databases", "test.start", { connection: PERMITS.name }),
    );
    await rig.module.idle();
    expect(second.job).toBe(first.job);
    expect(rig.jobs).toHaveLength(1);
    rig.now.value = new Date(rig.now.value.getTime() + 2_000);
    const third = payload<{ job: string }>(
      await ask(rig, "databases", "test.start", { connection: PERMITS.name }),
    );
    await rig.module.idle();
    expect(third.job).not.toBe(first.job);
    expect(rig.jobs).toHaveLength(2);
  });

  test("a connection or a job this organization does not have is one word, and no more", async () => {
    rig = await makeDatabasesRig();
    expect(await ask(rig, "databases", "test.start", { connection: "No such connection" })).toEqual({
      ok: false,
      error: "failed:connection_unknown",
    });
    expect(await ask(rig, "databases", "job.read", { job: "job_missing" })).toEqual({
      ok: false,
      error: "failed:job_unknown",
    });
    expect(await ask(rig, "databases", "catalog.read", { connection: "No such connection", page: 0 })).toEqual({
      ok: false,
      error: "failed:connection_unknown",
    });
  });

  test("at most four jobs run at once", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rig = await makeDatabasesRig({ hold: () => held });
    for (let i = 1; i <= 5; i += 1) {
      await addConnection(rig, { ...PERMITS, name: `Northstar permits ${i}` });
    }
    const replies = [];
    for (let i = 1; i <= 5; i += 1) {
      replies.push(await ask(rig, "databases", "test.start", { connection: `Northstar permits ${i}` }));
    }
    expect(replies.slice(0, 4).every((reply) => reply?.ok)).toBe(true);
    expect(replies[4]).toEqual({ ok: false, error: "failed:busy" });
    release();
    await rig.module.idle();
  });
});

describe("catalog.read", () => {
  test("before any test has passed there is no catalog", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })).toEqual({
      ok: false,
      error: "failed:catalog_not_read",
    });
  });

  test("answers tables and columns by name, each type as one word and its length as a count", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await testConnection(rig);
    const page = payload<Record<string, unknown>>(
      await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 }),
    );
    expect(page).toMatchObject({
      readAt: rig.now.value.toISOString(),
      page: 0,
      pages: 1,
      tables: 4,
      columns: 14,
      leftOut: { tables: 1, columns: 1 },
      truncated: false,
    });
    const items = page.items as Record<string, unknown>[];
    expect(items.map((item) => `${String(item.schema)}.${String(item.name)}`)).toEqual([
      "dbo.permits",
      "dbo.open_permits",
      "dbo.inspections",
      "dbo.broken_view",
    ]);
    expect(items[0]).toEqual({
      schema: "dbo",
      name: "permits",
      kind: "table",
      rows: 1204,
      columnCount: 6,
      first: 0,
      columns: [
        { name: "permit_no", type: "characters", nullable: false, length: 20, key: 1 },
        { name: "address", type: "characters", nullable: false, length: 200 },
        { name: "type", type: "characters", nullable: false, length: 40 },
        { name: "issued", type: "date", nullable: true },
        { name: "valuation", type: "decimal", nullable: true, length: 12, scale: 2 },
        { name: "applicant", type: "characters", nullable: true },
      ],
    });
    // A view has no estimate of its rows, so the answer has no such field.
    expect(items[1]).not.toHaveProperty("rows");
    expect(items[2]).toMatchObject({
      name: "inspections",
      columnCount: 5,
      columns: [
        { name: "id", type: "whole_number" },
        { name: "permit_no", type: "characters" },
        { name: "passed", type: "flag" },
        { name: "seen_at", type: "date_time" },
        // On this engine a column of this type is a row's version: bytes.
        { name: "row_version", type: "binary", length: 8 },
      ],
    });
    expect(JSON.stringify(page)).not.toContain("nvarchar");
  });

  test("a page past the last one is refused", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await testConnection(rig);
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 1 })).toEqual({
      ok: false,
      error: "failed:page_unknown",
    });
  });
});

describe("no answer can hold a row", () => {
  test("after a test and a query, no row's value is in any answer, record, log line or state file", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    await testConnection(rig, PERMITS.name);
    await testConnection(rig, BILLING.name);
    // A person reads rows: the values are now in this process's memory.
    const read = await readRows(rig, "SELECT TOP 3 permit_no, address, applicant FROM permits ORDER BY permit_no", LENA);
    expect(read).toMatchObject({ status: 200 });
    expect(JSON.stringify(read)).toContain("18 Mill Road");
    // And a statement the database refuses with words that quote a value.
    const broken = await readRows(rig, "SELECT lot FROM broken_view", LENA);
    expect(broken).toMatchObject({ status: 422, code: "query-failed" });
    expect(JSON.stringify(broken)).toContain("18 Mill Road");

    const answers: unknown[] = [await ask(rig, "databases", "connections.list")];
    for (const name of [PERMITS.name, BILLING.name]) {
      answers.push(await ask(rig, "databases", "catalog.read", { connection: name, page: 0 }));
      const started = payload<{ job: string }>(
        await ask(rig, "databases", "test.start", { connection: name }),
      );
      answers.push(started, await ask(rig, "databases", "job.read", started));
    }
    await rig.module.idle();
    answers.push(await act(rig, "connections.read"));
    for (const answer of answers) expect((answer as { ok?: boolean }).ok ?? true).toBe(true);

    const everywhere = [
      JSON.stringify(answers),
      await spoolText(rig.paths),
      JSON.stringify(rig.logs),
      await everythingOnDisk(rig.paths.root),
    ].join("\n");
    for (const value of [...ROW_VALUES, PERMITS_PASSWORD, BILLING_PASSWORD]) {
      expect(everywhere).not.toContain(value);
    }
    // The catalog's names are there, so the search above looked in the right place.
    expect(everywhere).toContain("permit_no");
  });

  test("what the data runner prints beyond names and counts is dropped", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await testConnection(rig);
    const everywhere = [
      JSON.stringify(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })),
      JSON.stringify(await act(rig, "connections.read")),
      await everythingOnDisk(rig.paths.root),
    ].join("\n");
    // The server's own version sentence, the engine's own type names and the
    // cipher are text the database or the program chose.
    for (const text of ["Example SQL Server", "nvarchar", "datetime2", "TLS_AES_256_GCM_SHA384"]) {
      expect(everywhere).not.toContain(text);
    }
  });

  test("a module's answer with a field the shape does not declare is refused whole", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const onAsk = rig.module.onAsk.bind(rig.module);
    // What a mistake in this module would look like: a row beside the names.
    const original = rig.registry.get("databases") as unknown as { onAsk: typeof onAsk };
    original.onAsk = async (name, args, ctx) => ({
      ...((await onAsk(name, args, ctx)) as object),
      rows: [["BP-2026-0412", "18 Mill Road"]],
    });
    expect(await ask(rig, "databases", "connections.list")).toEqual({ ok: false, error: "reply_invalid" });
    expect(await spoolText(rig.paths)).not.toContain("18 Mill Road");
  });
});

describe("each organization's connections are its own", () => {
  // A made-up second organization this Fortress holds data for.
  const ALDER = "alder-dental";

  async function askFor(of: DatabasesRig, org: string, name: string, args: Record<string, unknown> = {}) {
    return of.host.asks.handle({
      module: "databases",
      id: `m-${org}-${name}`,
      kind: "request",
      payload: { v: 1, ask: name, args, grant: await of.key.grant("databases", name, args, { org }) },
    });
  }

  test("an ask for another organization sees none of the own organization's connections", async () => {
    rig = await makeDatabasesRig();
    await writeOrganizations(rig.paths, [{ id: ALDER, modules: ["databases"] }]);
    await addConnection(rig);
    await testConnection(rig);
    expect(await askFor(rig, ALDER, "connections.list")).toEqual({ ok: true, payload: { connections: [] } });
    expect(await askFor(rig, ALDER, "test.start", { connection: PERMITS.name })).toEqual({
      ok: false,
      error: "failed:connection_unknown",
    });
    expect(await askFor(rig, ALDER, "catalog.read", { connection: PERMITS.name, page: 0 })).toEqual({
      ok: false,
      error: "failed:connection_unknown",
    });
    // The job's id is the own organization's too.
    const { connections } = payload<{ connections: unknown[] }>(await ask(rig, "databases", "connections.list"));
    expect(connections).toHaveLength(1);
    const book = await rig.ctx.state.read<{ jobs: { id: string }[] }>("connections");
    expect(await askFor(rig, ALDER, "job.read", { job: book?.jobs[0]?.id ?? "" })).toEqual({
      ok: false,
      error: "failed:job_unknown",
    });
    // And the module is off for an organization whose entry does not list it.
    await writeOrganizations(rig.paths, [{ id: ALDER, modules: [] }]);
    expect(await askFor(rig, ALDER, "connections.list")).toEqual({ ok: false, error: "module_off" });
  });
});

describe("an ask changes no connection", () => {
  test("the control plane cannot add, change or remove one: there is no such ask", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    for (const name of ["connection.add", "connection.change", "connection.remove", "connections.read"]) {
      expect(await ask(rig, "databases", name, PERMITS)).toEqual({ ok: false, error: "ask_unknown" });
    }
    await expect(rig.module.onAsk("connection.add", PERMITS, rig.ctx)).rejects.toMatchObject({
      code: "ask_not_implemented",
    });
    const { connections } = payload<{ connections: unknown[] }>(
      await ask(rig, "databases", "connections.list"),
    );
    expect(connections).toHaveLength(1);
  });

  test("the module is off until somebody on the host switches it on", async () => {
    rig = await makeDatabasesRig({ enabled: ["session_vault", "probe"] });
    expect(await ask(rig, "databases", "connections.list")).toEqual({ ok: false, error: "module_off" });
  });
});
