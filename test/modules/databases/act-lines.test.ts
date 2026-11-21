// Which of the Databases module's lines in the audit trail name a person.
//
// The module host writes a person's login on a line only when the module says
// that the line is a record of that person's act (`ctx.audit.recordAct`), and
// only while the act runs. Every other line names nobody. These tests go
// through the host's own act gate and ask gate, and read the lines as the
// audit trail holds them.

import { afterEach, describe, expect, test } from "bun:test";

import type { Person } from "../../../src/host/module-contract";
import { ask, spoolRecords } from "../../host/_module-rig";
import { act, addConnection, BILLING, deferred, makeDatabasesRig, MARTA, PERMITS, type DatabasesRig } from "./_rig";

let rig: DatabasesRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

// A second operator. Her login is an address with a plus sign: the console
// takes it, and no `name` can hold it.
const ADA: Person = { login: "ada+ops@northstar.example", email: "ada+ops@northstar.example", role: "operator" };

interface Line {
  action: string;
  under: string | null;
  target: unknown;
  job: unknown;
  code: unknown;
}

/** The module's own lines, oldest first, with who each is under. */
async function lines(of: DatabasesRig): Promise<Line[]> {
  await of.host.audit.flush();
  return (await spoolRecords(of.paths))
    .filter((record) => record.action.startsWith("module.databases."))
    .map((record) => {
      const params = (record.params ?? {}) as Record<string, unknown>;
      return {
        action: record.action.slice("module.databases.".length),
        under: record.actor,
        target: params.target,
        job: params.job,
        code: params.code,
      };
    });
}

/** Wait until the trail holds a line of this action for this job. A line is
 *  written without being waited for. */
async function lineOf(of: DatabasesRig, action: string, job: string): Promise<Line> {
  for (let i = 0; i < 400; i += 1) {
    const found = (await lines(of)).find((line) => line.action === action && line.job === job);
    if (found) return found;
    await Bun.sleep(5);
  }
  throw new Error(`no line ${action} for the job`);
}

async function linesOf(of: DatabasesRig, action: string, count: number): Promise<Line[]> {
  for (let i = 0; i < 400; i += 1) {
    const found = (await lines(of)).filter((line) => line.action === action);
    if (found.length >= count) return found;
    await Bun.sleep(5);
  }
  throw new Error(`fewer than ${count} lines ${action}`);
}

/** Make every write of one state key fail until the returned function is called. */
function failWrites(of: DatabasesRig, key: string): () => void {
  const write = of.ctx.state.write.bind(of.ctx.state);
  of.ctx.state.write = async <T>(name: string, value: T): Promise<void> => {
    if (name === key) throw Object.assign(new Error("no room on the disk"), { code: "ENOSPC" });
    return write(name, value);
  };
  return () => {
    of.ctx.state.write = write;
  };
}

describe("a person's own act", () => {
  test("adding, changing and removing a connection each leave a line under the person's login", async () => {
    rig = await makeDatabasesRig();
    expect(await act(rig, "connection.add", PERMITS, ADA)).toMatchObject({ ok: true });
    expect(await act(rig, "connection.add", BILLING)).toMatchObject({ ok: true });
    expect(await act(rig, "connection.change", { ...BILLING, database: "billing_2027" })).toMatchObject({ ok: true });
    expect(await act(rig, "connection.remove", { name: BILLING.name }, ADA)).toMatchObject({ ok: true });
    await linesOf(rig, "connection.remove", 1);
    expect((await lines(rig)).map((line) => [line.action, line.under, line.target])).toEqual([
      // Her login is kept whole, though no name can hold it.
      ["connection.add", ADA.login, PERMITS.name],
      ["connection.add", MARTA.login, BILLING.name],
      ["connection.change", MARTA.login, BILLING.name],
      ["connection.remove", ADA.login, BILLING.name],
    ]);
  });

  test("the start of a test is the person's, and its end is nobody's: nobody is acting when it ends", async () => {
    const held = deferred();
    rig = await makeDatabasesRig({ hold: () => held.promise });
    await addConnection(rig);
    const started = await act(rig, "connection.test", { name: PERMITS.name }, ADA);
    const job = (started as { payload: { job: string } }).payload.job;
    expect(await lineOf(rig, "connection.test", job)).toMatchObject({ under: ADA.login, target: PERMITS.name });
    // Her act was answered with the job's id. The test itself ends now.
    held.resolve();
    await rig.module.idle();
    expect(await lineOf(rig, "connection.tested", job)).toMatchObject({ under: null, target: PERMITS.name });
  });
});

describe("work that is not the person's own act", () => {
  test("a test that the control plane starts names nobody, at its start and at its end", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const started = await ask(rig, "databases", "test.start", { connection: PERMITS.name });
    expect(started).toMatchObject({ ok: true });
    const job = (started as { payload: { job: string } }).payload.job;
    await rig.module.idle();
    expect(await lineOf(rig, "connection.test", job)).toMatchObject({ under: null });
    expect(await lineOf(rig, "connection.tested", job)).toMatchObject({ under: null });
  });

  test("the end of somebody else's lost test names nobody, also when an operator's act is what closes it", async () => {
    const held = deferred();
    rig = await makeDatabasesRig({ hold: () => held.promise });
    await addConnection(rig);
    // The control plane starts a test. The disk fills while it runs, so its
    // end cannot be saved: the stored record still calls it running.
    const started = await ask(rig, "databases", "test.start", { connection: PERMITS.name });
    const lost = (started as { payload: { job: string } }).payload.job;
    const mend = failWrites(rig, "connections");
    held.resolve();
    await rig.module.idle();
    mend();
    // Ada tests the connection. On its way her act closes the lost test, and
    // writes the line of that test's end.
    const again = await act(rig, "connection.test", { name: PERMITS.name }, ADA);
    expect(again).toMatchObject({ ok: true });
    const hers = (again as { payload: { job: string } }).payload.job;
    expect(hers).not.toBe(lost);
    await rig.module.idle();
    // The lost test was the control plane's. Its end is under nobody's login:
    // Ada did not start it and did not end it.
    expect(await lineOf(rig, "connection.test.failed", lost)).toEqual({
      action: "connection.test.failed",
      under: null,
      target: PERMITS.name,
      job: lost,
      code: "interrupted",
    });
    // Her own test's start is under hers.
    expect(await lineOf(rig, "connection.test", hers)).toMatchObject({ under: ADA.login });
    // Nothing else of the module's own is under her login.
    expect((await lines(rig)).filter((line) => line.under === ADA.login).map((line) => [line.action, line.job])).toEqual([
      ["connection.test", hers],
    ]);
  });

  test("the same holds when the act that closes it is an add, a change or a remove", async () => {
    const held = deferred();
    rig = await makeDatabasesRig({ hold: () => held.promise });
    await addConnection(rig);
    const started = await ask(rig, "databases", "test.start", { connection: PERMITS.name });
    const lost = (started as { payload: { job: string } }).payload.job;
    const mend = failWrites(rig, "connections");
    held.resolve();
    await rig.module.idle();
    mend();
    expect(await act(rig, "connection.add", BILLING, ADA)).toMatchObject({ ok: true });
    expect(await lineOf(rig, "connection.test.failed", lost)).toMatchObject({ under: null, code: "interrupted" });
    expect((await linesOf(rig, "connection.add", 2)).map((line) => [line.target, line.under])).toEqual([
      [PERMITS.name, MARTA.login],
      [BILLING.name, ADA.login],
    ]);
  });
});
